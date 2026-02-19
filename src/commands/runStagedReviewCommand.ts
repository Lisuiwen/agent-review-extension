/**
 * 命令：agentreview.runStaged - 仅审查 staged 变更
 */

import * as vscode from 'vscode';
import type { CommandContext } from './commandContext';

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
            statusBar.updateStatus('reviewing');
            reviewPanel.setStatus('reviewing');
            reviewPanel.reveal();

            const result = await reviewEngine.reviewStagedFiles();
            reviewPanel.showReviewResult(result, 'completed', '', '没有staged文件需要审查');
            statusBar.updateWithResult(result);
        } catch (error) {
            logger.error('staged 审查过程出错', error);
            statusBar.updateStatus('error');
            reviewPanel.setStatus('error');
            vscode.window.showErrorMessage('staged 审查失败，请查看输出日志');
        }
    });
