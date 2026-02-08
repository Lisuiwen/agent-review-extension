/**
 * 命令：agentreview.fixIssue - 修复当前问题（占位）
 *
 * 从 reviewPanel.getActiveIssueForActions() 取 issue，无则提示，有则占位提示。
 * 后续可接入 AI 或 CodeLens。
 */

import * as vscode from 'vscode';
import type { CommandContext } from './commandContext';

export const registerFixIssueCommand = (deps: CommandContext): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.fixIssue', async () => {
        const { reviewPanel } = deps;
        const issue = reviewPanel?.getActiveIssueForActions();
        if (!issue) {
            vscode.window.showInformationMessage('请先在审查结果中选中一个问题，或悬停到问题行上再点击修复');
            return;
        }
        vscode.window.showInformationMessage('修复功能占位，后续可接入 AI 或 CodeLens');
    });
