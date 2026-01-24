/**
 * 审查结果面板
 * 
 * 这个文件实现了 VSCode 的 TreeView，用于在侧边栏显示审查结果
 * 
 * 主要组件：
 * 1. ReviewTreeItem: TreeView 中的每个节点（文件或问题）
 * 2. ReviewPanelProvider: TreeView 的数据提供者，负责构建树形结构
 * 3. ReviewPanel: 面板管理器，负责创建和管理 TreeView
 * 
 * TreeView 结构：
 * - 根节点：显示审查状态和统计
 *   - 文件节点：按文件分组显示问题
 *     - 问题节点：具体的问题项，点击可跳转到代码位置
 * 
 * 使用方式：
 * ```typescript
 * const reviewPanel = new ReviewPanel(context);
 * reviewPanel.showReviewResult(result);
 * ```
 */

import * as vscode from 'vscode';
import { ReviewResult, ReviewIssue } from '../core/reviewEngine';
import * as path from 'path';

/**
 * TreeView 节点类
 * 
 * 这个类表示 TreeView 中的一个节点，可以是：
 * - 文件节点：显示文件路径和问题统计
 * - 问题节点：显示具体的问题信息，点击可跳转到代码位置
 * 
 * VSCode TreeView 要求每个节点都继承自 vscode.TreeItem
 */
export class ReviewTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly issue?: ReviewIssue,
        public readonly filePath?: string
    ) {
        super(label, collapsibleState);

        if (issue) {
            // 问题项：显示详细信息并设置点击命令
            this.tooltip = `${issue.message}\n规则: ${issue.rule}`;
            this.description = `行 ${issue.line}, 列 ${issue.column}`;
            
            // 根据严重程度设置图标
            switch (issue.severity) {
                case 'error':
                    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                    break;
                case 'warning':
                    this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
                    break;
                case 'info':
                    this.iconPath = new vscode.ThemeIcon('info', new vscode.ThemeColor('editorInfo.foreground'));
                    break;
            }

            // 设置点击命令，跳转到文件位置
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
        } else if (filePath) {
            // 文件项：显示文件路径
            this.tooltip = filePath;
            this.iconPath = vscode.ThemeIcon.File;
            this.resourceUri = vscode.Uri.file(filePath);
        }
    }
}

/**
 * TreeView 数据提供者
 * 
 * 这个类实现了 vscode.TreeDataProvider 接口，负责：
 * 1. 管理审查结果数据
 * 2. 构建树形结构（根节点 -> 文件节点 -> 问题节点）
 * 3. 响应数据变化，刷新视图
 * 
 * VSCode 会调用 getChildren 方法来获取子节点，调用 getTreeItem 来获取节点显示信息
 */
export class ReviewPanelProvider implements vscode.TreeDataProvider<ReviewTreeItem> {
    // 事件发射器：当数据变化时，通知 TreeView 刷新
    // 这是 VSCode TreeView 的标准模式
    private _onDidChangeTreeData: vscode.EventEmitter<ReviewTreeItem | undefined | null | void> = new vscode.EventEmitter<ReviewTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ReviewTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private reviewResult: ReviewResult | null = null;  // 当前的审查结果
    private status: 'idle' | 'reviewing' | 'completed' | 'error' = 'idle';  // 审查状态

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    updateResult(result: ReviewResult | null, status: 'idle' | 'reviewing' | 'completed' | 'error' = 'completed'): void {
        this.reviewResult = result;
        this.status = status;
        this.refresh();
    }

    getStatus(): 'idle' | 'reviewing' | 'completed' | 'error' {
        return this.status;
    }

    getCurrentResult(): ReviewResult | null {
        return this.reviewResult;
    }

    getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
        return element;
    }

    /**
     * 获取子节点
     * 
     * 这是 TreeView 的核心方法，VSCode 会调用它来构建树形结构
     * 
     * @param element - 父节点，如果为 undefined 表示获取根节点的子节点
     * @returns 子节点数组
     * 
     * 树形结构：
     * - 根节点（element === undefined）：
     *   - 状态节点：显示审查是否通过
     *   - 文件节点：每个有问题的文件一个节点
     * - 文件节点（element.filePath 存在）：
     *   - 问题节点：该文件的所有问题
     */
    getChildren(element?: ReviewTreeItem): ReviewTreeItem[] {
        // 如果没有审查结果，显示提示信息
        if (!this.reviewResult) {
            if (this.status === 'reviewing') {
                return [new ReviewTreeItem('正在审查...', vscode.TreeItemCollapsibleState.None)];
            }
            return [new ReviewTreeItem('点击刷新按钮开始审查', vscode.TreeItemCollapsibleState.None)];
        }

        // 根节点的子节点：显示状态和按文件分组的问题
        if (!element) {
            const items: ReviewTreeItem[] = [];
            
            // 如果没有问题且审查通过，检查是否是因为没有staged文件
            const totalIssues = this.reviewResult.errors.length + this.reviewResult.warnings.length + this.reviewResult.info.length;
            if (this.reviewResult.passed && totalIssues === 0) {
                // 可能是没有staged文件的情况，显示提示信息
                items.push(new ReviewTreeItem('没有staged文件需要审查', vscode.TreeItemCollapsibleState.None));
                return items;
            }
            
            // 状态项
            const statusText = this.reviewResult.passed 
                ? '✓ 审查通过' 
                : `✗ 审查未通过 (${this.reviewResult.errors.length}个错误, ${this.reviewResult.warnings.length}个警告)`;
            items.push(new ReviewTreeItem(statusText, vscode.TreeItemCollapsibleState.None));

            // 按文件分组显示问题
            const fileMap = new Map<string, ReviewIssue[]>();
            
            [...this.reviewResult.errors, ...this.reviewResult.warnings, ...this.reviewResult.info].forEach(issue => {
                if (!fileMap.has(issue.file)) {
                    fileMap.set(issue.file, []);
                }
                fileMap.get(issue.file)!.push(issue);
            });

            // 为每个文件创建节点
            for (const [filePath, issues] of fileMap.entries()) {
                const fileName = path.basename(filePath);
                const errorCount = issues.filter(i => i.severity === 'error').length;
                const warningCount = issues.filter(i => i.severity === 'warning').length;
                const infoCount = issues.filter(i => i.severity === 'info').length;
                
                const countText = [
                    errorCount > 0 ? `${errorCount}个错误` : '',
                    warningCount > 0 ? `${warningCount}个警告` : '',
                    infoCount > 0 ? `${infoCount}个信息` : ''
                ].filter(Boolean).join(', ');

                const fileItem = new ReviewTreeItem(
                    `${fileName} (${countText})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    undefined,
                    filePath
                );
                items.push(fileItem);
            }

            return items;
        }

        // 文件节点：显示该文件的所有问题
        if (element.filePath) {
            const fileIssues = [
                ...this.reviewResult.errors,
                ...this.reviewResult.warnings,
                ...this.reviewResult.info
            ].filter(issue => issue.file === element.filePath);

            return fileIssues.map(issue => 
                new ReviewTreeItem(
                    `${issue.message} [${issue.rule}]`,
                    vscode.TreeItemCollapsibleState.None,
                    issue
                )
            );
        }

        return [];
    }
}

export class ReviewPanel {
    private treeView: vscode.TreeView<ReviewTreeItem>;
    private provider: ReviewPanelProvider;

    constructor(context: vscode.ExtensionContext) {
        this.provider = new ReviewPanelProvider(context);
        this.treeView = vscode.window.createTreeView('agentReview.results', {
            treeDataProvider: this.provider,
            showCollapseAll: true
        });
    }

    showReviewResult(result: ReviewResult, status: 'idle' | 'reviewing' | 'completed' | 'error' = 'completed'): void {
        this.provider.updateResult(result, status);
    }

    setStatus(status: 'idle' | 'reviewing' | 'completed' | 'error'): void {
        // 保持当前结果，只更新状态
        const currentResult = this.provider.getCurrentResult();
        this.provider.updateResult(currentResult, status);
    }

    getStatus(): 'idle' | 'reviewing' | 'completed' | 'error' {
        return this.provider.getStatus();
    }

    reveal(): void {
        // TreeView 已经在侧边栏显示，无需额外操作
        // 刷新视图以显示最新内容
        this.provider.refresh();
    }

    dispose(): void {
        this.treeView.dispose();
    }
}
