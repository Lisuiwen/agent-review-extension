/**
 * 命令：agentreview.refresh - 刷新审查结果
 *
 * 通常绑定到 TreeView 标题栏的刷新按钮，等同于重新执行 agentreview.run。
 */

import * as vscode from 'vscode';

export const registerRefreshCommand = (): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.refresh', async () => {
        await vscode.commands.executeCommand('agentreview.run');
    });
