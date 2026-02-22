/**
 * 命令 agentreview.run：手动触发代码审查（待提交变更）。
 */

import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import type { CommandContext } from './commandContext';
import type { ReviewResult } from '../types/review';
import { IssueDeduplicator } from '../core/issueDeduplicator';
import { getGitWorkspaceFolders, getWorkspaceFolders } from '../utils/workspaceRoot';
import { runPendingReviewAcrossRoots } from '../core/multiRootCoordinator';

const createContentHash = (content: string): string =>
    createHash('sha1').update(content, 'utf8').digest('hex');

const countIssues = (result: ReviewResult): number =>
    result.errors.length + result.warnings.length + result.info.length;

const dedupeReviewedResult = (result: ReviewResult): ReviewResult => {
    const deduplicatedIssues = IssueDeduplicator.dedupeAiIssuesByLineSimilarity([
        ...result.errors,
        ...result.warnings,
        ...result.info,
    ]);

    return {
        ...result,
        passed: deduplicatedIssues.every((issue) => issue.severity !== 'error'),
        errors: deduplicatedIssues.filter((issue) => issue.severity === 'error'),
        warnings: deduplicatedIssues.filter((issue) => issue.severity === 'warning'),
        info: deduplicatedIssues.filter((issue) => issue.severity === 'info'),
    };
};

const showResultNotification = (result: ReviewResult, preserveHistoricalOnEmpty: boolean): void => {
    if (preserveHistoricalOnEmpty) {
        vscode.window.showInformationMessage('复审未命中，已保留历史问题');
        return;
    }

    if (result.passed) {
        if (result.warnings.length > 0 || result.info.length > 0) {
            vscode.window.showInformationMessage(
                `✅ 代码审查通过 (${result.warnings.length}个警告, ${result.info.length}个信息)`
            );
        } else {
            vscode.window.showInformationMessage('✅ 代码审查通过');
        }
        return;
    }

    vscode.window.showWarningMessage(
        `代码审查发现问题: ${result.errors.length}个错误, ${result.warnings.length}个警告`
    );
};

export const registerRunReviewCommand = (deps: CommandContext): vscode.Disposable => {
    let inProgress = false;
    const getBatchConcurrency = (): number => {
        const configured = deps.configManager?.getConfig().ai_review?.batch_concurrency;
        return typeof configured === 'number' && configured > 0 ? Math.floor(configured) : 2;
    };

    return vscode.commands.registerCommand('agentreview.run', async () => {
        const { reviewEngine, reviewPanel, statusBar, logger } = deps;
        logger.info('执行代码审查命令');

        if (!reviewEngine || !reviewPanel || !statusBar) {
            logger.error('组件未初始化', {
                reviewEngine: !!reviewEngine,
                reviewPanel: !!reviewPanel,
                statusBar: !!statusBar,
            });
            vscode.window.showErrorMessage('组件未初始化');
            return;
        }

        if (inProgress) {
            vscode.window.showInformationMessage('审查进行中，已忽略重复刷新');
            return;
        }

        inProgress = true;
        try {
            logger.info('开始执行审查流程');
            await vscode.window.withProgress(
                { location: { viewId: 'agentReview.results' }, title: '审查中...' },
                async () => {
                    statusBar.updateStatus('reviewing');
                    reviewPanel.setStatus('reviewing');
                    reviewPanel.reveal();

                    const workspaceFolders = getWorkspaceFolders();
                    const multiRootMode = workspaceFolders.length > 1;
                    const gitWorkspaceRoots = getGitWorkspaceFolders().map(item => item.uri.fsPath);
                    const { result, reason, pendingFiles } = multiRootMode
                        ? await runPendingReviewAcrossRoots(reviewEngine, gitWorkspaceRoots, getBatchConcurrency())
                        : await reviewEngine.reviewPendingChangesWithContext();
                    logger.info('审查流程执行完成');

                    const finalResult = reason === 'reviewed' ? dedupeReviewedResult(result) : result;
                    const resultIssueCount = countIssues(finalResult);
                    const currentResult = reviewPanel.getCurrentResult();
                    const currentIssueCount = currentResult ? countIssues(currentResult) : 0;
                    const preserveHistoricalOnEmpty =
                        reason === 'reviewed' && resultIssueCount === 0 && currentIssueCount > 0;

                    if (reason === 'no_pending_changes') {
                        reviewPanel.showReviewResult(finalResult, 'completed', '', '没有待提交变更需要审查');
                        statusBar.updateWithResult(finalResult);
                    } else if (preserveHistoricalOnEmpty) {
                        const message = '复审未命中，保留历史问题';
                        reviewPanel.setSubStatus(message);
                        statusBar.updateWithResult(currentResult!, message);
                    } else {
                        reviewPanel.showReviewResult(
                            finalResult,
                            'completed',
                            '',
                            resultIssueCount === 0 ? '当前待提交变更未发现问题' : ''
                        );
                        statusBar.updateWithResult(finalResult);
                        if (reason === 'reviewed' && pendingFiles.length > 0 && deps.persistLastReviewedHash) {
                            const norm = (p: string) => path.normalize(p);
                            for (const filePath of pendingFiles) {
                                try {
                                    const doc = vscode.workspace.textDocuments.find(
                                        (d) => d.uri.scheme === 'file' && norm(d.uri.fsPath) === norm(filePath)
                                    ) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                                    const content = typeof doc.getText === 'function' ? doc.getText() : '';
                                    deps.persistLastReviewedHash(filePath, createContentHash(content));
                                } catch {
                                    // 无法读取文档时跳过该文件，不写入 hash
                                }
                            }
                        }
                    }

                    showResultNotification(finalResult, preserveHistoricalOnEmpty);
                }
            );
        } catch (error) {
            logger.error('审查过程出错', error);
            statusBar.updateStatus('error');
            reviewPanel.setStatus('error');
            vscode.window.showErrorMessage('代码审查失败，请查看输出日志');
        } finally {
            inProgress = false;
        }
    });
};
