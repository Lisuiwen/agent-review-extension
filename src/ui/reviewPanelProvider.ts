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
    /** 分组节点缓存（项目+来源），用于局部刷新时 fire(分组节点) 及 Panel 侧 reveal */
    private groupNodeCache: Map<string, ReviewTreeItem> = new Map();
    private static readonly UNASSIGNED_PROJECT_KEY = '__agentreview_unassigned_project__';

    private getAllIssues = (): ReviewIssue[] => {
        if (!this.reviewResult) return [];
        return [...this.reviewResult.errors, ...this.reviewResult.warnings, ...this.reviewResult.info];
    };

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    refreshGroup(groupKey: string): void {
        const node = this.groupNodeCache.get(groupKey);
        if (node) {
            this._onDidChangeTreeData.fire(node);
        } else {
            this._onDidChangeTreeData.fire();
        }
    }

    getCachedGroupNode(groupKey: string): ReviewTreeItem | null {
        return this.groupNodeCache.get(groupKey) ?? null;
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

    removeIssue(issue: ReviewIssue): string | undefined {
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
        const groupKey = this.buildSourceNodeKey(this.getProjectRootKey(issue), isAiIssue(issue) ? 'ai' : 'rule');
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
            this.groupNodeCache.clear();
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
                this.groupNodeCache.clear();
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

            const projectNodes = this.buildProjectNodes(this.getAllIssues());
            this.groupNodeCache.clear();
            items.push(...projectNodes);
            return items;
        }

        if (element.nodeType === 'project') {
            const projectRootKey = element.projectRoot ?? ReviewPanelProvider.UNASSIGNED_PROJECT_KEY;
            return this.buildSourceNodes(projectRootKey);
        }

        if (element.nodeType === 'source' && element.groupKey) {
            const projectRootKey = element.projectRoot ?? ReviewPanelProvider.UNASSIGNED_PROJECT_KEY;
            const groupIssues = this.getIssuesByProjectAndGroup(projectRootKey, element.groupKey);
            return this.buildFileItems(groupIssues, element.groupKey, projectRootKey);
        }

        if (element.nodeType === 'file' && element.filePath) {
            const groupIssues = element.groupKey
                ? this.getIssuesByProjectAndGroup(element.projectRoot ?? ReviewPanelProvider.UNASSIGNED_PROJECT_KEY, element.groupKey)
                : this.getIssuesByProject(element.projectRoot ?? ReviewPanelProvider.UNASSIGNED_PROJECT_KEY);
            const fileIssues = groupIssues.filter(issue => path.normalize(issue.file) === path.normalize(element.filePath!));
            return fileIssues.map(issue =>
                new ReviewTreeItem(
                    `${issue.ignored ? '【已放行】' : ''}${issue.stale ? '【待复审】' : ''}${issue.message} [${issue.rule}]`,
                    vscode.TreeItemCollapsibleState.None,
                    issue,
                    undefined,
                    undefined,
                    'issue',
                    this.getProjectRootKey(issue)
                )
            );
        }

        return [];
    }

    private getProjectRootKey = (issue: ReviewIssue): string =>
        issue.workspaceRoot ? path.normalize(issue.workspaceRoot) : ReviewPanelProvider.UNASSIGNED_PROJECT_KEY;

    private getIssuesByProject = (projectRootKey: string): ReviewIssue[] =>
        this.getAllIssues().filter(issue => this.getProjectRootKey(issue) === projectRootKey);

    private getIssuesByProjectAndGroup = (projectRootKey: string, groupKey: 'rule' | 'ai'): ReviewIssue[] => {
        const projectIssues = this.getIssuesByProject(projectRootKey);
        if (groupKey === 'ai') return projectIssues.filter(issue => isAiIssue(issue));
        return projectIssues.filter(issue => !isAiIssue(issue));
    };

    private buildSourceNodeKey = (projectRootKey: string, groupKey: 'rule' | 'ai'): string =>
        `${projectRootKey}::${groupKey}`;

    private getProjectLabelMap = (projectRootKeys: string[]): Map<string, string> => {
        const labelMap = new Map<string, string>();
        const uniqueKeys = Array.from(new Set(projectRootKeys));
        const realRoots = uniqueKeys.filter(key => key !== ReviewPanelProvider.UNASSIGNED_PROJECT_KEY);
        const rootsByBaseName = new Map<string, string[]>();
        for (const rootKey of realRoots) {
            const baseName = path.basename(rootKey) || rootKey;
            if (!rootsByBaseName.has(baseName)) rootsByBaseName.set(baseName, []);
            rootsByBaseName.get(baseName)!.push(rootKey);
        }

        labelMap.set(ReviewPanelProvider.UNASSIGNED_PROJECT_KEY, '未归属项目');

        for (const [baseName, roots] of rootsByBaseName.entries()) {
            if (roots.length === 1) {
                labelMap.set(roots[0], baseName);
                continue;
            }

            const rootToSegments = new Map<string, string[]>();
            let maxDepth = 1;
            for (const root of roots) {
                const normalized = root.replace(/\\/g, '/');
                const segments = normalized.split('/').filter(Boolean);
                const parentSegments = segments.slice(0, -1);
                rootToSegments.set(root, parentSegments);
                maxDepth = Math.max(maxDepth, parentSegments.length);
            }

            let selectedDepth = maxDepth;
            for (let depth = 1; depth <= maxDepth; depth++) {
                const suffixes = roots.map(root => {
                    const segments = rootToSegments.get(root) ?? [];
                    return segments.slice(-depth).join('/');
                });
                const uniqueCount = new Set(suffixes).size;
                if (uniqueCount === roots.length) {
                    selectedDepth = depth;
                    break;
                }
            }

            for (const root of roots) {
                const segments = rootToSegments.get(root) ?? [];
                const suffix = segments.slice(-selectedDepth).join('/');
                labelMap.set(root, suffix ? `${baseName} (${suffix})` : baseName);
            }
        }

        return labelMap;
    };

    private buildProjectNodes = (issues: ReviewIssue[]): ReviewTreeItem[] => {
        const byProject = new Map<string, ReviewIssue[]>();
        for (const issue of issues) {
            const key = this.getProjectRootKey(issue);
            const list = byProject.get(key);
            if (list) list.push(issue);
            else byProject.set(key, [issue]);
        }

        const projectKeys = Array.from(byProject.keys());
        const labelMap = this.getProjectLabelMap(projectKeys);

        return projectKeys.map(projectRootKey =>
            new ReviewTreeItem(
                labelMap.get(projectRootKey) ?? projectRootKey,
                vscode.TreeItemCollapsibleState.Expanded,
                undefined,
                undefined,
                undefined,
                'project',
                projectRootKey
            )
        );
    };

    private buildSourceNodes = (projectRootKey: string): ReviewTreeItem[] => {
        const ruleIssues = this.getIssuesByProjectAndGroup(projectRootKey, 'rule');
        const aiIssues = this.getIssuesByProjectAndGroup(projectRootKey, 'ai');

        const ruleNode = new ReviewTreeItem(
            `规则检测错误 (${ruleIssues.length})`,
            vscode.TreeItemCollapsibleState.Expanded,
            undefined,
            undefined,
            'rule',
            'source',
            projectRootKey
        );
        const aiNode = new ReviewTreeItem(
            `AI检测错误 (${aiIssues.length})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            undefined,
            undefined,
            'ai',
            'source',
            projectRootKey
        );

        this.groupNodeCache.set(this.buildSourceNodeKey(projectRootKey, 'rule'), ruleNode);
        this.groupNodeCache.set(this.buildSourceNodeKey(projectRootKey, 'ai'), aiNode);
        return [ruleNode, aiNode];
    };

    private buildFileItems = (issues: ReviewIssue[], groupKey?: 'rule' | 'ai', projectRootKey?: string): ReviewTreeItem[] => {
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
                    groupKey,
                    'file',
                    projectRootKey
                )
            );
        }
        return items;
    };
}
