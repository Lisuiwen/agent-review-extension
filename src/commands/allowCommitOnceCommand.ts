/**
 * 命令：agentreview.allowCommitOnce - 一次性放行提交
 *
 * 创建放行标记文件 .git/agentreview/allow-commit，HookRunner 检测后跳过一次审查并删除标记。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { CommandContext } from './commandContext';

export const registerAllowCommitOnceCommand = (deps: CommandContext): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.allowCommitOnce', async () => {
        const { configManager, logger, getGitRoot } = deps;
        if (!configManager) {
            vscode.window.showErrorMessage('配置管理器未初始化');
            return;
        }
        const config = configManager.getConfig();
        if (config.git_hooks?.allow_commit_once === false) {
            vscode.window.showInformationMessage('当前配置已禁用“一次性放行”');
            return;
        }
        const gitRoot = getGitRoot();
        if (!gitRoot) {
            vscode.window.showErrorMessage('未找到 Git 根目录，无法放行提交');
            return;
        }
        const tokenDir = path.join(gitRoot, '.git', 'agentreview');
        const tokenPath = path.join(tokenDir, 'allow-commit');
        try {
            await fs.promises.mkdir(tokenDir, { recursive: true });
            const tokenContent = `allowed-at=${new Date().toISOString()}\n`;
            await fs.promises.writeFile(tokenPath, tokenContent, 'utf-8');
            vscode.window.showInformationMessage('已放行下一次提交（一次性）');
        } catch (error) {
            logger.error('创建放行标记失败', error);
            vscode.window.showErrorMessage('放行提交失败，请检查权限或路径');
        }
    });
