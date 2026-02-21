/**
 * 审查结果树节点
 *
 * 根状态/文件/分组/问题项均用此类。问题节点显示消息、规则、行号等，点击可跳转；
 * 文件节点显示路径；分组为规则量/存量。VSCode TreeView 要求每个节点均继承自 vscode.TreeItem。
 */

import * as vscode from 'vscode';
import type { ReviewIssue } from '../types/review';

export class ReviewTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly issue?: ReviewIssue,
        public readonly filePath?: string,
        public readonly groupKey?: 'rule' | 'ai'
    ) {
        super(label, collapsibleState);

        if (issue) {
            const parts = [issue.reason ? `\n原因: ${issue.reason}` : '', issue.ignored ? '\n状态: 已放行（@ai-ignore）' : '', issue.ignoreReason ? `\n放行原因: ${issue.ignoreReason}` : '', issue.stale ? '\n状态: 已同步位置（待复审）' : ''];
            this.tooltip = `${issue.message}\n规则: ${issue.rule}${parts.join('')}`;
            const pos = `行 ${issue.line}, 列 ${issue.column}`;
            this.description = issue.ignored ? `已放行 · ${pos}` : issue.stale ? `待复审 · ${pos}` : pos;

            if (issue.ignored) {
                this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('descriptionForeground'));
            } else {
                const severityIcon: Record<string, { icon: string; color: vscode.ThemeColor }> = {
                    error: { icon: 'error', color: new vscode.ThemeColor('errorForeground') },
                    warning: { icon: 'warning', color: new vscode.ThemeColor('editorWarning.foreground') },
                    info: { icon: 'info', color: new vscode.ThemeColor('editorInfo.foreground') },
                };
                const s = severityIcon[issue.severity];
                if (s) this.iconPath = new vscode.ThemeIcon(s.icon, s.color);
            }

            this.command = {
                command: 'vscode.open',
                title: '打开文件',
                arguments: [
                    vscode.Uri.file(issue.file),
                    {
                        selection: new vscode.Range(
                            issue.line - 1,
                            issue.column - 1,
                            issue.line - 1,
                            issue.column
                        )
                    }
                ]
            };
            this.contextValue = issue.severity === 'error' ? 'reviewIssue' : 'reviewIssueNonError';
        } else if (filePath) {
            this.tooltip = filePath;
            this.iconPath = vscode.ThemeIcon.File;
            this.resourceUri = vscode.Uri.file(filePath);
            this.contextValue = 'reviewFile';
        } else if (groupKey) {
            this.contextValue = 'reviewGroup';
        }
    }
}
