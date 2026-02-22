/**
 * 命令：agentreview.runStaged - 仅审查 staged 变更
 */

import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import type { CommandContext } from './commandContext';

const createContentHash = (content: string): string =>
    createHash('sha1').update(content, 'utf8').digest('hex');

export const registerRunStagedReviewCommand = (deps: CommandContext): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.runStaged', async () => {
        const { reviewEngine, reviewPanel, statusBar, logger } = deps;
        logger.info('执行 staged 代码审查命令');
        if (!reviewEngine || !reviewPanel || !statusBar) {
            logger.error('组件未初始化', {
                reviewEngine: !!reviewEngine,
                reviewPanel: !!reviewPanel,
                statusBar: !!statusBar,
            });
            vscode.window.showErrorMessage('组件未初始化');
            return;
        }

        try {
            await vscode.window.withProgress(
                { location: { viewId: 'agentReview.results' }, title: '审查中…' },
                async () => {
                    statusBar.updateStatus('reviewing');
                    reviewPanel.setStatus('reviewing');
                    reviewPanel.reveal();

                    const { result, stagedFiles } = await reviewEngine.reviewStagedFilesWithContext();
                    reviewPanel.showReviewResult(result, 'completed', '', '没有staged文件需要审查');
                    statusBar.updateWithResult(result);
                    if (stagedFiles.length > 0 && deps.persistLastReviewedHash) {
                        const norm = (p: string) => path.normalize(p);
                        for (const filePath of stagedFiles) {
                            try {
                                const doc = vscode.workspace.textDocuments.find(
                                    (d) => d.uri.scheme === 'file' && norm(d.uri.fsPath) === norm(filePath)
                                ) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                                const content = typeof doc.getText === 'function' ? doc.getText() : '';
                                deps.persistLastReviewedHash(filePath, createContentHash(content));
                            } catch {
                                // 无法读取文档时跳过该文件
                            }
                        }
                    }
                }
            );
        } catch (error) {
            logger.error('staged 审查过程出错', error);
            statusBar.updateStatus('error');
            reviewPanel.setStatus('error');
            vscode.window.showErrorMessage('staged 审查失败，请查看输出日志');
        }
    });
