/**
 * 命令：agentreview.review - 保持向后兼容的别名
 *
 * 直接调用 agentreview.run。
 */

import * as vscode from 'vscode';

export const registerReviewCommand = (): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.review', async () => {
        await vscode.commands.executeCommand('agentreview.run');
    });
