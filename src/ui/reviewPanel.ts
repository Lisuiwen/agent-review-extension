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
 *   - 分组节点：你的增量 / 项目存量
 *     - 文件节点：按文件分组显示问题
 *       - 问题节点：具体的问题项，点击可跳转到代码位置
 * 
 * 使用方式：
 * ```typescript
 * const reviewPanel = new ReviewPanel(context);
 * reviewPanel.showReviewResult(result);
 * ```
 */

import * as vscode from 'vscode';
import type { ReviewResult, ReviewIssue } from '../types/review';
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
        public readonly filePath?: string,
        public readonly groupKey?: 'incremental' | 'existing'
    ) {
        super(label, collapsibleState);

        if (issue) {
            // 问题项：显示详细信息并设置点击命令
            const reasonText = issue.reason ? `\n原因: ${issue.reason}` : '';
            this.tooltip = `${issue.message}\n规则: ${issue.rule}${reasonText}`;
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
            // contextValue 用于控制 TreeView 菜单显示
            this.contextValue = 'reviewIssue';
        } else if (filePath) {
            // 文件项：显示文件路径
            this.tooltip = filePath;
            this.iconPath = vscode.ThemeIcon.File;
            this.resourceUri = vscode.Uri.file(filePath);
            this.contextValue = 'reviewFile';
        } else if (groupKey) {
            // 分组项：增量 / 存量
            this.contextValue = 'reviewGroup';
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
     *   - 分组节点：你的增量 / 项目存量
     *     - 文件节点：每个有问题的文件一个节点
     * - 文件节点（element.filePath 存在）：
     *   - 问题节点：该文件的所有问题
     */
    getChildren(element?: ReviewTreeItem): ReviewTreeItem[] {
        // 如果没有审查结果，显示提示信息
        if (!this.reviewResult) {
            if (this.status === 'reviewing') {
                const loadingItem = new ReviewTreeItem('正在审查...', vscode.TreeItemCollapsibleState.None);
                loadingItem.iconPath = new vscode.ThemeIcon('sync~spin');
                loadingItem.description = '请稍候';
                return [loadingItem];
            }
            return [new ReviewTreeItem('点击刷新按钮开始审查', vscode.TreeItemCollapsibleState.None)];
        }

        // 根节点的子节点：显示状态和按文件分组的问题
        if (!element) {
            const items: ReviewTreeItem[] = [];
            
            // 审查进行中时，优先显示明显的加载提示
            if (this.status === 'reviewing') {
                const loadingItem = new ReviewTreeItem('正在审查...', vscode.TreeItemCollapsibleState.None);
                loadingItem.iconPath = new vscode.ThemeIcon('sync~spin');
                loadingItem.description = '请稍候';
                items.push(loadingItem);
            }
            
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

            // 根节点分两类：你的增量（默认展开）与项目存量（默认折叠）
            const allIssues = [...this.reviewResult.errors, ...this.reviewResult.warnings, ...this.reviewResult.info];
            const incrementalIssues = allIssues.filter(issue => issue.incremental === true);
            const existingIssues = allIssues.filter(issue => issue.incremental !== true);

            if (incrementalIssues.length > 0) {
                items.push(new ReviewTreeItem(
                    `你的增量 (${incrementalIssues.length})`,
                    vscode.TreeItemCollapsibleState.Expanded,
                    undefined,
                    undefined,
                    'incremental'
                ));
            }
            if (existingIssues.length > 0) {
                items.push(new ReviewTreeItem(
                    `项目存量 (${existingIssues.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    undefined,
                    undefined,
                    'existing'
                ));
            }

            // 向后兼容：若没有打标数据，则按旧逻辑退化为单层文件分组
            if (incrementalIssues.length === 0 && existingIssues.length === 0 && allIssues.length > 0) {
                const fallbackFileItems = this.buildFileItems(allIssues);
                items.push(...fallbackFileItems);
            }

            return items;
        }

        // 分组节点：展示该分组下的文件列表
        if (element.groupKey && !element.filePath) {
            const groupIssues = this.getIssuesByGroup(element.groupKey);
            return this.buildFileItems(groupIssues, element.groupKey);
        }

        // 文件节点：显示该文件的所有问题
        if (element.filePath) {
            const groupIssues = element.groupKey ? this.getIssuesByGroup(element.groupKey) : [
                ...this.reviewResult.errors,
                ...this.reviewResult.warnings,
                ...this.reviewResult.info
            ];
            const fileIssues = groupIssues.filter(issue => issue.file === element.filePath);

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

    /**
     * 按分组类型获取问题列表：
     * - incremental: 本次增量
     * - existing: 项目存量
     */
    private getIssuesByGroup = (groupKey: 'incremental' | 'existing'): ReviewIssue[] => {
        if (!this.reviewResult) {
            return [];
        }
        const allIssues = [...this.reviewResult.errors, ...this.reviewResult.warnings, ...this.reviewResult.info];
        if (groupKey === 'incremental') {
            return allIssues.filter(issue => issue.incremental === true);
        }
        return allIssues.filter(issue => issue.incremental !== true);
    };

    /**
     * 将问题按文件聚合成 TreeItem。
     */
    private buildFileItems = (
        issues: ReviewIssue[],
        groupKey?: 'incremental' | 'existing'
    ): ReviewTreeItem[] => {
        const fileMap = new Map<string, ReviewIssue[]>();
        for (const issue of issues) {
            if (!fileMap.has(issue.file)) {
                fileMap.set(issue.file, []);
            }
            fileMap.get(issue.file)!.push(issue);
        }

        const items: ReviewTreeItem[] = [];
        for (const [filePath, fileIssues] of fileMap.entries()) {
            const fileName = path.basename(filePath);
            const errorCount = fileIssues.filter(i => i.severity === 'error').length;
            const warningCount = fileIssues.filter(i => i.severity === 'warning').length;
            const infoCount = fileIssues.filter(i => i.severity === 'info').length;
            const countText = [
                errorCount > 0 ? `${errorCount}个错误` : '',
                warningCount > 0 ? `${warningCount}个警告` : '',
                infoCount > 0 ? `${infoCount}个信息` : ''
            ].filter(Boolean).join(', ');

            items.push(new ReviewTreeItem(
                `${fileName} (${countText})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                undefined,
                filePath,
                groupKey
            ));
        }
        return items;
    };
}

export class ReviewPanel {
    private treeView: vscode.TreeView<ReviewTreeItem>;
    private provider: ReviewPanelProvider;
    private highlightDecoration: vscode.TextEditorDecorationType;
    private errorHighlightDecoration: vscode.TextEditorDecorationType;
    private warningHighlightDecoration: vscode.TextEditorDecorationType;
    private infoHighlightDecoration: vscode.TextEditorDecorationType;
    private astHighlightDecoration: vscode.TextEditorDecorationType;
    private lastHighlightedEditor: vscode.TextEditor | null = null;
    private selectionDisposable: vscode.Disposable;
    private hoverProvider: vscode.Disposable;
    /** 当前在 Hover 中展示的问题，供「修复」等命令读取 */
    private activeIssueForActions: ReviewIssue | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.provider = new ReviewPanelProvider(context);
        this.treeView = vscode.window.createTreeView('agentReview.results', {
            treeDataProvider: this.provider,
            showCollapseAll: true
        });

        // 高亮装饰：用于标记当前选中的问题行
        // 使用主题颜色，保证不同主题下可读性
        this.highlightDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editor.lineHighlightBackground'),
            border: '1px solid',
            borderColor: new vscode.ThemeColor('editor.lineHighlightBorder')
        });
        
        // 错误高亮：红色强调，用于 error 严重级别
        this.errorHighlightDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editorError.background'),
            border: '1px solid',
            borderColor: new vscode.ThemeColor('errorForeground')
        });
        
        // 警告高亮：黄色强调，用于 warning 严重级别
        this.warningHighlightDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editorWarning.background'),
            border: '1px solid',
            borderColor: new vscode.ThemeColor('editorWarning.foreground')
        });

        // 信息高亮：蓝色强调，用于 info 严重级别
        this.infoHighlightDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editorInfo.background'),
            border: '1px solid',
            borderColor: new vscode.ThemeColor('editorInfo.foreground')
        });

        // AST 范围高亮：较浅的范围标识，用于二级范围提示
        this.astHighlightDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
            border: '1px solid',
            borderColor: new vscode.ThemeColor('editor.rangeHighlightBorder')
        });

        // 详情说明：Hover 浮层（类似 TS 报错），不占行号，支持可点击操作
        this.hoverProvider = vscode.languages.registerHoverProvider(
            { scheme: 'file' },
            { provideHover: (document, position) => this.provideIssueHover(document, position) }
        );
        context.subscriptions.push(this.hoverProvider);

        // 监听 TreeView 选择变化，实现“选中即高亮”
        this.selectionDisposable = this.treeView.onDidChangeSelection((event) => {
            const selectedItem = event.selection[0];
            if (!selectedItem || !selectedItem.issue) {
                this.clearHighlight();
                return;
            }
            void this.highlightIssue(selectedItem.issue);
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

    getCurrentResult(): ReviewResult | null {
        return this.provider.getCurrentResult();
    }

    reveal(): void {
        // TreeView 已经在侧边栏显示，无需额外操作
        // 刷新视图以显示最新内容
        this.provider.refresh();
    }

    /**
     * 清理当前高亮
     * 
     * 当选中非问题节点或发生异常时，移除旧的高亮
     */
    private clearHighlight = (): void => {
        if (this.lastHighlightedEditor) {
            this.lastHighlightedEditor.setDecorations(this.highlightDecoration, []);
            this.lastHighlightedEditor.setDecorations(this.errorHighlightDecoration, []);
            this.lastHighlightedEditor.setDecorations(this.warningHighlightDecoration, []);
            this.lastHighlightedEditor.setDecorations(this.infoHighlightDecoration, []);
            this.lastHighlightedEditor.setDecorations(this.astHighlightDecoration, []);
            this.lastHighlightedEditor = null;
        }
        this.activeIssueForActions = null;
    };

    /**
     * 高亮并定位问题行
     * 
     * @param issue - 需要定位的问题
     */
    private highlightIssue = async (issue: ReviewIssue): Promise<void> => {
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(issue.file));
            const editor = await vscode.window.showTextDocument(document, {
                preserveFocus: false,
                preview: true
            });

            // 安全校正行列号，避免越界导致异常
            const safeLine = Math.min(Math.max(issue.line, 1), document.lineCount);
            const lineText = document.lineAt(safeLine - 1).text;
            const safeColumn = Math.min(Math.max(issue.column, 1), lineText.length + 1);

            const position = new vscode.Position(safeLine - 1, safeColumn - 1);
            const selection = new vscode.Selection(position, position);
            editor.selection = selection;
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);

            // 先清理旧高亮，再设置新高亮
            this.clearHighlight();
            const lineRange = new vscode.Range(safeLine - 1, 0, safeLine - 1, lineText.length);
            
            // 按严重程度选择高亮样式
            if (issue.severity === 'error') {
                editor.setDecorations(this.errorHighlightDecoration, [lineRange]);
            } else if (issue.severity === 'warning') {
                editor.setDecorations(this.warningHighlightDecoration, [lineRange]);
            } else if (issue.severity === 'info') {
                editor.setDecorations(this.infoHighlightDecoration, [lineRange]);
            } else {
                editor.setDecorations(this.highlightDecoration, [lineRange]);
            }

            // AST 范围高亮：用于二级范围提示
            if (issue.astRange) {
                const astStartLine = Math.max(1, issue.astRange.startLine);
                const astEndLine = Math.min(document.lineCount, issue.astRange.endLine);
                if (astEndLine >= astStartLine) {
                    const astEndText = document.lineAt(astEndLine - 1).text;
                    const astRange = new vscode.Range(
                        astStartLine - 1,
                        0,
                        astEndLine - 1,
                        astEndText.length
                    );
                    editor.setDecorations(this.astHighlightDecoration, [astRange]);
                }
            }

            this.activeIssueForActions = issue;
            this.lastHighlightedEditor = editor;
        } catch (error) {
            this.clearHighlight();
            vscode.window.showWarningMessage('无法打开文件进行定位，请检查文件路径是否有效');
        }
    };

    /**
     * 提供问题详情的 Hover 浮层（仅通过悬停触发，与 TS/ESLint 报错样式一致、内容自适应）
     * 仅当光标所在行属于当前审查结果中的问题时返回内容；点击 Tree 节点不触发浮层
     */
    private provideIssueHover = (
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | undefined => {
        const result = this.provider.getCurrentResult();
        if (!result) return undefined;
        const line1 = position.line + 1;
        const norm = (p: string) => p.replace(/\\/g, '/');
        const docPath = norm(document.uri.fsPath);
        const issues = [...result.errors, ...result.warnings, ...result.info].filter(
            (i) => norm(i.file) === docPath && i.line === line1
        );
        const issue = issues[0];
        if (!issue) return undefined;
        this.activeIssueForActions = issue;
        return new vscode.Hover(this.buildIssueHoverMarkdown(issue));
    };

    /**
     * 构建 Hover 浮层内容：紧凑、自适应，风格与 TS/ESLint 报错一致（无厚重边框）
     */
    private buildIssueHoverMarkdown = (issue: ReviewIssue): vscode.MarkdownString => {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        const severityLabel = issue.severity === 'error' ? '错误' : issue.severity === 'warning' ? '警告' : '信息';
        md.appendMarkdown(`${severityLabel}: `);
        md.appendText(issue.message);
        md.appendMarkdown('\n\n');
        md.appendMarkdown(`规则: ${issue.rule}`);
        if (issue.reason && issue.reason !== issue.message) {
            md.appendMarkdown('\n');
            md.appendText(issue.reason);
        }
        if (issue.astRange) {
            md.appendMarkdown(`\nAST: 第 ${issue.astRange.startLine}-${issue.astRange.endLine} 行`);
        }
        md.appendMarkdown('\n\n');
        md.appendMarkdown('[本次放行](command:agentreview.allowCommitOnce) · [修复](command:agentreview.fixIssue)');
        return md;
    };

    /** 供「修复」等命令读取当前 Hover 对应的问题 */
    getActiveIssueForActions(): ReviewIssue | null {
        return this.activeIssueForActions;
    }

    dispose(): void {
        this.clearHighlight();
        this.highlightDecoration.dispose();
        this.errorHighlightDecoration.dispose();
        this.warningHighlightDecoration.dispose();
        this.infoHighlightDecoration.dispose();
        this.astHighlightDecoration.dispose();
        this.hoverProvider.dispose();
        this.selectionDisposable.dispose();
        this.treeView.dispose();
    }
}
