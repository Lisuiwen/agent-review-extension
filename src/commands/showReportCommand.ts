/**
 * 命令：agentreview.showReport - 显示审查报告
 *
 * 打开侧边栏的审查结果面板。
 */

import * as vscode from 'vscode';
import type { CommandContext } from './commandContext';

export const registerShowReportCommand = (deps: CommandContext): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.showReport', async () => {
        const { reviewPanel, logger } = deps;
        logger.info('显示审查报告命令');
        if (reviewPanel) {
            reviewPanel.reveal();
            logger.info('审查面板已显示');
        } else {
            logger.warn('审查面板未初始化');
            vscode.window.showInformationMessage('审查面板未初始化');
        }
    });
