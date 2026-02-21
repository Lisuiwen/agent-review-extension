/**
 * 审查结果 TreeView 数据提供者
 *
 * 实现 vscode.TreeDataProvider<ReviewTreeItem>，管理审查结果数据与树形结构：
 * 根节点（状态/通过与否/规则/AI 分组）-> 文件节点 -> 问题节点。
 * 支持局部刷新（如忽略后只刷新该分组）、分组节点缓存供 Panel 做 reveal。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { ReviewResult, ReviewIssue } from '../types/review';
import { ReviewTreeItem } from './reviewTreeItem';
import { isAiIssue } from './reviewPanel.types';
import { isSameIssue } from './reviewPanel.helpers';

export class ReviewPanelProvider implements vscode.TreeDataProvider<ReviewTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ReviewTreeItem | undefined | null | void> =
        new vscode.EventEmitter<ReviewTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ReviewTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private reviewResult: ReviewResult | null = null;
    private status: 'idle' | 'reviewing' | 'completed' | 'error' = 'idle';
    private statusMessage: string | null = null;
    private emptyStateHint: string | null = null;
    /** 根下分组节点缓存，用于局部刷新时 fire(分组节点) 及 Panel 侧 reveal */
    private groupNodeCache: { rule: ReviewTreeItem | null; ai: ReviewTreeItem | null } = { rule: null, ai: null };

    private getAllIssues = (): ReviewIssue[] => {
        if (!this.reviewResult) return [];
        return [...this.reviewResult.errors, ...this.reviewResult.warnings, ...this.reviewResult.info];
    };

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    refreshGroup(groupKey: 'rule' | 'ai'): void {
        const node = this.groupNodeCache[groupKey];
        if (node) {
            this._onDidChangeTreeData.fire(node);
        } else {
            this._onDidChangeTreeData.fire();
        }
    }

    getCachedGroupNode(groupKey: 'rule' | 'ai'): ReviewTreeItem | null {
        return this.groupNodeCache[groupKey] ?? null;
    }

    updateResult(
        result: ReviewResult | null,
        status: 'idle' | 'reviewing' | 'completed' | 'error' = 'completed',
        statusMessage?: string,
        emptyStateHint?: string
    ): void {
        this.reviewResult = result;
        this.status = status;
        if (statusMessage !== undefined) {
            this.statusMessage = statusMessage || null;
        }
        if (emptyStateHint !== undefined) {
            this.emptyStateHint = emptyStateHint || null;
        }
        this.refresh();
    }

    getStatus(): 'idle' | 'reviewing' | 'completed' | 'error' {
        return this.status;
    }

    getCurrentResult(): ReviewResult | null {
        return this.reviewResult;
    }

    removeIssue(issue: ReviewIssue): 'rule' | 'ai' | undefined {
        if (!this.reviewResult) return undefined;
        const match = (a: ReviewIssue) => isSameIssue(a, issue);
        const errors = this.reviewResult.errors.filter(i => !match(i));
        const warnings = this.reviewResult.warnings.filter(i => !match(i));
        const info = this.reviewResult.info.filter(i => !match(i));
        this.reviewResult = {
            passed: errors.length === 0,
            errors,
            warnings,
            info,
        };
        const groupKey = isAiIssue(issue) ? 'ai' : 'rule';
        this.refresh();
        return groupKey;
    }

    getStatusMessage(): string | null {
        return this.statusMessage;
    }

    private createStatusMessageItem(): ReviewTreeItem | null {
        if (!this.statusMessage) return null;
        const statusItem = new ReviewTreeItem(this.statusMessage, vscode.TreeItemCollapsibleState.None);
        statusItem.iconPath = new vscode.ThemeIcon('info');
        return statusItem;
    }

    getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ReviewTreeItem): ReviewTreeItem[] {
        if (!this.reviewResult) {
            this.groupNodeCache = { rule: null, ai: null };
            const statusItem = this.status !== 'reviewing' ? this.createStatusMessageItem() : null;
            return statusItem ? [statusItem] : [new ReviewTreeItem('点击刷新按钮开始复审', vscode.TreeItemCollapsibleState.None)];
        }

        if (!element) {
            const items: ReviewTreeItem[] = [];
            if (this.status !== 'reviewing') {
                const statusItem = this.createStatusMessageItem();
                if (statusItem) items.push(statusItem);
            }
            const totalIssues =
                this.reviewResult.errors.length +
                this.reviewResult.warnings.length +
                this.reviewResult.info.length;
            if (this.reviewResult.passed && totalIssues === 0) {
                this.groupNodeCache = { rule: null, ai: null };
                items.push(
                    new ReviewTreeItem(
                        this.emptyStateHint ?? '无 staged 变更',
                        vscode.TreeItemCollapsibleState.None
                    )
                );
                return items;
            }
            const statusText = this.reviewResult.passed
                ? '通过'
                : `审查未通过 (${this.reviewResult.errors.length}个错误, ${this.reviewResult.warnings.length}个警告)`;
            items.push(new ReviewTreeItem(statusText, vscode.TreeItemCollapsibleState.None));

            const allIssues = this.getAllIssues();
            const ruleIssues = allIssues.filter(issue => !isAiIssue(issue));
            const aiIssues = allIssues.filter(issue => isAiIssue(issue));
            const ruleNode = new ReviewTreeItem(
                `规则检测错误 (${ruleIssues.length})`,
                vscode.TreeItemCollapsibleState.Expanded,
                undefined,
                undefined,
                'rule'
            );
            const aiNode = new ReviewTreeItem(
                `AI检测错误 (${aiIssues.length})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                undefined,
                undefined,
                'ai'
            );
            this.groupNodeCache = { rule: ruleNode, ai: aiNode };
            items.push(ruleNode);
            items.push(aiNode);
            return items;
        }

        if (element.groupKey && !element.filePath) {
            const groupIssues = this.getIssuesByGroup(element.groupKey);
            return this.buildFileItems(groupIssues, element.groupKey);
        }

        if (element.filePath) {
            const groupIssues = element.groupKey ? this.getIssuesByGroup(element.groupKey) : this.getAllIssues();
            const fileIssues = groupIssues.filter(issue => issue.file === element.filePath);
            return fileIssues.map(issue =>
                new ReviewTreeItem(
                    `${issue.ignored ? '【已放行】' : ''}${issue.stale ? '【待复审】' : ''}${issue.message} [${issue.rule}]`,
                    vscode.TreeItemCollapsibleState.None,
                    issue
                )
            );
        }

        return [];
    }

    private getIssuesByGroup = (groupKey: 'rule' | 'ai'): ReviewIssue[] => {
        if (!this.reviewResult) return [];
        const allIssues = this.getAllIssues();
        if (groupKey === 'ai') return allIssues.filter(issue => isAiIssue(issue));
        return allIssues.filter(issue => !isAiIssue(issue));
    };

    private buildFileItems = (issues: ReviewIssue[], groupKey?: 'rule' | 'ai'): ReviewTreeItem[] => {
        const fileMap = new Map<string, ReviewIssue[]>();
        for (const issue of issues) {
            const list = fileMap.get(issue.file);
            if (list) list.push(issue);
            else fileMap.set(issue.file, [issue]);
        }
        const countBySeverity = (fileIssues: ReviewIssue[]) => {
            let e = 0, w = 0, i = 0;
            for (const issue of fileIssues) {
                if (issue.severity === 'error') e++;
                else if (issue.severity === 'warning') w++;
                else if (issue.severity === 'info') i++;
            }
            return [e, w, i] as const;
        };
        const items: ReviewTreeItem[] = [];
        for (const [filePath, fileIssues] of fileMap.entries()) {
            const fileName = path.basename(filePath);
            const [errorCount, warningCount, infoCount] = countBySeverity(fileIssues);
            const countText = [
                errorCount > 0 ? `${errorCount}` : '',
                warningCount > 0 ? `${warningCount}` : '',
                infoCount > 0 ? `${infoCount}` : '',
            ]
                .filter(Boolean)
                .join(', ');
            items.push(
                new ReviewTreeItem(
                    `${fileName} (${countText})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    undefined,
                    filePath,
                    groupKey
                )
            );
        }
        return items;
    };
}
