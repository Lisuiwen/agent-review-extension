/**
 * 命令：agentreview.ignoreIssue - 忽略当前问题（仅写指纹，不写源码注释）
 *
 * 仅对 warning/info 显示；error 无此按钮。执行后从 TreeView 立即移除该条。
 * 行为：计算指纹 + 写入 .vscode/agentreview-ignore.json（带可读 meta），然后 removeIssueFromList。
 */

import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandContext } from './commandContext';
import type { ReviewTreeItem } from '../ui/reviewPanel';
import type { ReviewIssue } from '../types/review';
import { computeIssueFingerprint } from '../utils/issueFingerprint';
import { addIgnoredFingerprint } from '../config/ignoreStore';
import { getEffectiveWorkspaceRoot } from '../utils/workspaceRoot';

const getIssue = (deps: CommandContext, treeItem?: ReviewTreeItem): ReviewIssue | null => {
    if (treeItem?.issue) {
        return treeItem.issue;
    }
    return deps.reviewPanel?.getActiveIssueForActions() ?? null;
};

export const registerIgnoreIssueCommand = (deps: CommandContext): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.ignoreIssue', async (treeItem?: ReviewTreeItem) => {
        const issue = getIssue(deps, treeItem);
        if (!issue) {
            vscode.window.showInformationMessage('请先在审查结果中选中一个问题，或悬停到问题行后再执行忽略');
            return;
        }
        if (issue.severity === 'error') {
            vscode.window.showInformationMessage('error 级别不可忽略');
            return;
        }

        const workspaceRoot = issue.workspaceRoot || getEffectiveWorkspaceRoot()?.uri.fsPath;
        if (workspaceRoot) {
            let content: string;
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(issue.file));
                content = doc.getText();
            } catch {
                vscode.window.showErrorMessage('无法读取文件内容，忽略失败');
                return;
            }
            const fingerprint = computeIssueFingerprint(issue, content, workspaceRoot);
            if (fingerprint) {
                const relativePath = path.relative(workspaceRoot, issue.file);
                const file = path.normalize(relativePath).replace(/\\/g, '/');
                await addIgnoredFingerprint(workspaceRoot, fingerprint, {
                    file,
                    line: issue.line,
                    rule: issue.rule,
                    message: issue.message,
                    severity: issue.severity,
                });
            }
        }

        deps.reviewPanel?.removeIssueFromList(issue);
        vscode.window.showInformationMessage('已忽略，已从列表移除');
    });
