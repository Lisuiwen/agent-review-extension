/**
 * 命令：agentreview.run - 手动触发代码审查
 *
 * 更新状态为 reviewing、调用 reviewEngine.reviewStagedFiles()、
 * 更新 panel/statusBar、根据 result 弹出通知。
 */

import * as vscode from 'vscode';
import type { CommandContext } from './commandContext';

export const registerRunReviewCommand = (deps: CommandContext): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.run', async () => {
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

        try {
            logger.info('开始执行审查流程');
            statusBar.updateStatus('reviewing');
            reviewPanel.setStatus('reviewing');
            reviewPanel.reveal();

            const result = await reviewEngine.reviewStagedFiles();
            logger.info('审查流程执行完成');

            reviewPanel.showReviewResult(result, 'completed');
            statusBar.updateWithResult(result);

            if (result.passed) {
                if (result.warnings.length > 0 || result.info.length > 0) {
                    vscode.window.showInformationMessage(
                        `✓ 代码审查通过 (${result.warnings.length}个警告, ${result.info.length}个信息)`
                    );
                } else {
                    vscode.window.showInformationMessage('✓ 代码审查通过');
                }
            } else {
                const errorCount = result.errors.length;
                const warningCount = result.warnings.length;
                vscode.window.showWarningMessage(
                    `代码审查发现问题: ${errorCount}个错误, ${warningCount}个警告`
                );
            }
        } catch (error) {
            logger.error('审查过程出错', error);
            statusBar.updateStatus('error');
            reviewPanel.setStatus('error');
            vscode.window.showErrorMessage('代码审查失败，请查看输出日志');
        }
    });
