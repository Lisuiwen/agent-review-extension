/**
 * 命令：agentreview.installHooks - 手动安装 Git Hooks
 *
 * 调用 gitHookManager.installPreCommitHook() 并弹窗结果。
 */

import * as vscode from 'vscode';
import type { CommandContext } from './commandContext';

export const registerInstallHooksCommand = (deps: CommandContext): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.installHooks', async () => {
        const { gitHookManager, logger } = deps;
        logger.info('安装Git Hooks命令');
        if (!gitHookManager) {
            vscode.window.showErrorMessage('Git Hook管理器未初始化');
            return;
        }

        try {
            const success = await gitHookManager.installPreCommitHook();
            if (success) {
                vscode.window.showInformationMessage('✓ Git Hooks安装成功');
            } else {
                vscode.window.showWarningMessage('Git Hooks安装失败或已存在');
            }
        } catch (error) {
            logger.error('安装Git Hooks失败', error);
            vscode.window.showErrorMessage('安装Git Hooks失败');
        }
    });
