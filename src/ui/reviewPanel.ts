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

type IgnoreLineMeta = {
    ignoredLines: Set<number>;
    reasonByLine: Map<number, string>;
};

type StaleScopeHint = {
    startLine: number;
    endLine: number;
    source: 'ast' | 'line';
};

type ReviewedRange = {
    startLine: number;
    endLine: number;
};

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
            const ignoreText = issue.ignored ? '\n状态: 已放行（@ai-ignore）' : '';
            const ignoreReasonText = issue.ignoreReason ? `\n放行原因: ${issue.ignoreReason}` : '';
            const staleText = issue.stale ? '\n状态: 已同步位置（待复审）' : '';
            this.tooltip = `${issue.message}\n规则: ${issue.rule}${reasonText}${ignoreText}${ignoreReasonText}${staleText}`;
            if (issue.ignored) {
                this.description = `已放行 · 行 ${issue.line}, 列 ${issue.column}`;
            } else if (issue.stale) {
                this.description = `待复审 · 行 ${issue.line}, 列 ${issue.column}`;
            } else {
                this.description = `行 ${issue.line}, 列 ${issue.column}`;
            }
            
            // 根据严重程度设置图标
            if (issue.ignored) {
                this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('descriptionForeground'));
            } else {
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
    private statusMessage: string | null = null; // 子状态文案（排队中/待复审/限频中等）
    private emptyStateHint: string | null = null; // 无问题时的场景化提示文案

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
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

    getStatusMessage(): string | null {
        return this.statusMessage;
    }

    private createStatusMessageItem(): ReviewTreeItem | null {
        if (!this.statusMessage) {
            return null;
        }
        const statusItem = new ReviewTreeItem(this.statusMessage, vscode.TreeItemCollapsibleState.None);
        statusItem.iconPath = new vscode.ThemeIcon('info');
        return statusItem;
    }

    getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
        return element;
    }

    /**
     * TreeView 核心方法：根据父节点返回子节点。
     * 根（element 为空）→ 状态/分组（你的增量、项目存量）；分组 → 文件；文件 → 问题列表。
     */
    getChildren(element?: ReviewTreeItem): ReviewTreeItem[] {
        if (!this.reviewResult) {
            const statusItem = this.createStatusMessageItem();
            if (statusItem) {
                return [statusItem];
            }
            if (this.status === 'reviewing') {
                const loadingItem = new ReviewTreeItem('正在审查...', vscode.TreeItemCollapsibleState.None);
                loadingItem.iconPath = new vscode.ThemeIcon('sync~spin');
                loadingItem.description = '请稍候';
                return [loadingItem];
            }
            return [new ReviewTreeItem('点击刷新按钮开始审查', vscode.TreeItemCollapsibleState.None)];
        }

        if (!element) {
            // 根节点：状态文案、加载中、通过/未通过、你的增量 / 项目存量 分组
            const items: ReviewTreeItem[] = [];
            const statusItem = this.createStatusMessageItem();
            if (statusItem) {
                items.push(statusItem);
            }
            
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
                items.push(new ReviewTreeItem(
                    this.emptyStateHint ?? '没有staged文件需要审查',
                    vscode.TreeItemCollapsibleState.None
                ));
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

            // 始终显示“你的增量 / 项目存量”两个分栏，数量可为 0，避免用户误以为缺失分栏。
            items.push(new ReviewTreeItem(
                `你的增量 (${incrementalIssues.length})`,
                vscode.TreeItemCollapsibleState.Expanded,
                undefined,
                undefined,
                'incremental'
            ));
            items.push(new ReviewTreeItem(
                `项目存量 (${existingIssues.length})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                undefined,
                undefined,
                'existing'
            ));

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
                    `${issue.ignored ? '【已放行】 ' : ''}${issue.stale ? '【待复审】 ' : ''}${issue.message} [${issue.rule}]`,
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

    /** 将同一分组下的问题按文件聚合为「文件节点」TreeItem 列表 */
    private buildFileItems = (
        issues: ReviewIssue[],
        groupKey?: 'incremental' | 'existing'
    ): ReviewTreeItem[] => {
        const fileMap = new Map<string, ReviewIssue[]>();
        for (const issue of issues) {
            const list = fileMap.get(issue.file);
            if (list) list.push(issue);
            else fileMap.set(issue.file, [issue]);
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
    private documentChangeDisposable: vscode.Disposable;
    /** 当前在 Hover 中展示的问题，供「修复」等命令读取 */
    private activeIssueForActions: ReviewIssue | null = null;
    private enableLocalRebase = true;
    private largeChangeLineThreshold = 40;

    private getAllIssues = (result: ReviewResult): ReviewIssue[] => [
        ...result.errors,
        ...result.warnings,
        ...result.info,
    ];

    private mergeScopeHints = (rawHints: StaleScopeHint[]): StaleScopeHint[] => {
        if (rawHints.length === 0) {
            return [];
        }
        const sortedHints = [...rawHints].sort((a, b) =>
            a.startLine === b.startLine
                ? a.endLine - b.endLine
                : a.startLine - b.startLine
        );
        const merged: StaleScopeHint[] = [];
        for (const hint of sortedHints) {
            const last = merged[merged.length - 1];
            if (!last || hint.startLine > last.endLine + 1) {
                merged.push({ ...hint });
                continue;
            }
            last.endLine = Math.max(last.endLine, hint.endLine);
            if (hint.source === 'ast') {
                last.source = 'ast';
            }
        }
        return merged;
    };

    private deduplicateIssues = (issues: ReviewIssue[]): ReviewIssue[] => {
        const seen = new Set<string>();
        const deduplicated: ReviewIssue[] = [];
        for (const issue of issues) {
            const key = [
                path.normalize(issue.file),
                issue.line,
                issue.column,
                issue.rule,
                issue.severity,
                issue.message,
                issue.reason ?? '',
                issue.fingerprint ?? '',
            ].join('|');
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            deduplicated.push(issue);
        }
        return deduplicated;
    };

    private normalizeReviewedRanges = (ranges: ReviewedRange[]): ReviewedRange[] => {
        if (ranges.length === 0) {
            return [];
        }
        const normalized = ranges
            .map(range => {
                const startLine = Math.max(1, Math.floor(range.startLine));
                const endLine = Math.max(startLine, Math.floor(range.endLine));
                return { startLine, endLine };
            })
            .sort((a, b) => (
                a.startLine === b.startLine
                    ? a.endLine - b.endLine
                    : a.startLine - b.startLine
            ));
        const merged: ReviewedRange[] = [];
        for (const range of normalized) {
            const last = merged[merged.length - 1];
            if (!last || range.startLine > last.endLine + 1) {
                merged.push({ ...range });
                continue;
            }
            last.endLine = Math.max(last.endLine, range.endLine);
        }
        return merged;
    };

    private isLineInReviewedRanges = (line: number, reviewedRanges: ReviewedRange[]): boolean => {
        if (reviewedRanges.length === 0) {
            return false;
        }
        const normalizedLine = Math.max(1, Math.floor(line));
        return reviewedRanges.some(range => normalizedLine >= range.startLine && normalizedLine <= range.endLine);
    };

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

        const onDidChangeTextDocument = (vscode.workspace as unknown as {
            onDidChangeTextDocument?: (
                listener: (event: vscode.TextDocumentChangeEvent) => void
            ) => vscode.Disposable;
        }).onDidChangeTextDocument;
        this.documentChangeDisposable = onDidChangeTextDocument
            ? onDidChangeTextDocument((event) => {
                void this.syncAfterDocumentChange(event);
            })
            : { dispose: () => {} };
        context.subscriptions.push(this.documentChangeDisposable);
    }

    showReviewResult(
        result: ReviewResult,
        status: 'idle' | 'reviewing' | 'completed' | 'error' = 'completed',
        statusMessage = '',
        emptyStateHint = ''
    ): void {
        this.provider.updateResult(result, status, statusMessage, emptyStateHint);
    }

    setStatus(status: 'idle' | 'reviewing' | 'completed' | 'error', statusMessage = ''): void {
        // 保持当前结果，只更新状态
        const currentResult = this.provider.getCurrentResult();
        this.provider.updateResult(currentResult, status, statusMessage);
    }

    getStatus(): 'idle' | 'reviewing' | 'completed' | 'error' {
        return this.provider.getStatus();
    }

    getCurrentResult(): ReviewResult | null {
        return this.provider.getCurrentResult();
    }

    /**
     * 设置面板子状态文案，不改变主状态。
     */
    setSubStatus(statusMessage?: string): void {
        const currentResult = this.provider.getCurrentResult();
        this.provider.updateResult(currentResult, this.provider.getStatus(), statusMessage);
    }

    /**
     * 配置编辑期本地重映射行为（由 extension 启动时注入）。
     */
    configureLocalRebase(options: { enabled?: boolean; largeChangeLineThreshold?: number }): void {
        if (options.enabled !== undefined) {
            this.enableLocalRebase = options.enabled;
        }
        if (
            typeof options.largeChangeLineThreshold === 'number'
            && Number.isFinite(options.largeChangeLineThreshold)
            && options.largeChangeLineThreshold > 0
        ) {
            this.largeChangeLineThreshold = Math.floor(options.largeChangeLineThreshold);
        }
    }

    /**
     * 当前结果中某文件是否存在 stale issue，供“编辑停顿复审”策略判断。
     */
    isFileStale(filePath: string): boolean {
        const result = this.provider.getCurrentResult();
        if (!result) {
            return false;
        }
        const normalizedTarget = path.normalize(filePath);
        const allIssues = this.getAllIssues(result);
        return allIssues.some(issue => path.normalize(issue.file) === normalizedTarget && issue.stale === true);
    }

    /**
     * 获取某个文件中 stale 问题对应的复审范围提示：
     * - 优先使用 issue.astRange
     * - 无 astRange 时回退为 issue.line 单行范围
     * - 最终返回归并后的有序范围，减少重复复审
     */
    getStaleScopeHints(filePath: string): Array<{ startLine: number; endLine: number; source: 'ast' | 'line' }> {
        const result = this.provider.getCurrentResult();
        if (!result) {
            return [];
        }
        const normalizedTarget = path.normalize(filePath);
        const allIssues = this.getAllIssues(result);
        const rawHints: StaleScopeHint[] = [];

        for (const issue of allIssues) {
            if (path.normalize(issue.file) !== normalizedTarget || issue.stale !== true) {
                continue;
            }
            if (issue.astRange) {
                const startLine = Math.max(1, Math.floor(issue.astRange.startLine));
                const endLine = Math.max(startLine, Math.floor(issue.astRange.endLine));
                rawHints.push({
                    startLine,
                    endLine,
                    source: 'ast',
                });
                continue;
            }
            const line = Math.max(1, Math.floor(issue.line));
            rawHints.push({
                startLine: line,
                endLine: line,
                source: 'line',
            });
        }

        if (rawHints.length === 0) {
            return [];
        }
        return this.mergeScopeHints(rawHints);
    }

    /**
     * 将“单文件复审结果”按文件级补丁合并进当前面板：
     * - stale_only: 仅替换该文件 stale 问题
     * - all_in_file: 替换该文件所有问题
     */
    applyFileReviewPatch(params: {
        filePath: string;
        newResult: ReviewResult;
        replaceMode: 'stale_only' | 'all_in_file';
        status?: 'completed' | 'error';
        statusMessage?: string;
        emptyStateHint?: string;
        preserveStaleOnEmpty?: boolean;
        reviewedRanges?: Array<{ startLine: number; endLine: number }>;
        reviewedMode?: 'diff' | 'full';
    }): void {
        const normalizedTarget = path.normalize(params.filePath);
        const reviewedMode = params.reviewedMode ?? 'full';
        const reviewedRanges = this.normalizeReviewedRanges(params.reviewedRanges ?? []);
        const currentResult = this.provider.getCurrentResult() ?? {
            passed: true,
            errors: [],
            warnings: [],
            info: [],
        };
        const incomingBySeverity = {
            errors: params.newResult.errors.filter(issue => path.normalize(issue.file) === normalizedTarget),
            warnings: params.newResult.warnings.filter(issue => path.normalize(issue.file) === normalizedTarget),
            info: params.newResult.info.filter(issue => path.normalize(issue.file) === normalizedTarget),
        };
        const incomingIssueCount =
            incomingBySeverity.errors.length
            + incomingBySeverity.warnings.length
            + incomingBySeverity.info.length;
        const keepTargetStaleIssues =
            params.replaceMode === 'stale_only'
            && params.preserveStaleOnEmpty === true
            && incomingIssueCount === 0;

        const shouldKeepExistingIssue = (issue: ReviewIssue): boolean => {
            const isTargetFile = path.normalize(issue.file) === normalizedTarget;
            if (!isTargetFile) {
                return true;
            }
            if (keepTargetStaleIssues) {
                return true;
            }
            if (params.replaceMode === 'all_in_file') {
                return false;
            }
            if (issue.stale !== true) {
                return true;
            }
            if (reviewedMode === 'full') {
                return false;
            }
            if (reviewedRanges.length === 0) {
                // diff 覆盖范围缺失时采取保守策略，避免误删旧 stale 问题
                return true;
            }
            return !this.isLineInReviewedRanges(issue.line, reviewedRanges);
        };
        const nextResult: ReviewResult = {
            passed: true,
            errors: this.deduplicateIssues([
                ...currentResult.errors.filter(shouldKeepExistingIssue),
                ...incomingBySeverity.errors,
            ]),
            warnings: this.deduplicateIssues([
                ...currentResult.warnings.filter(shouldKeepExistingIssue),
                ...incomingBySeverity.warnings,
            ]),
            info: this.deduplicateIssues([
                ...currentResult.info.filter(shouldKeepExistingIssue),
                ...incomingBySeverity.info,
            ]),
        };
        nextResult.passed = nextResult.errors.length === 0;

        this.clearHighlight();
        this.provider.updateResult(
            nextResult,
            params.status ?? this.provider.getStatus(),
            params.statusMessage,
            params.emptyStateHint
        );
    }

    /**
     * 在“放行此条”插入 @ai-ignore 注释后，本地同步当前面板结果：
     * 1) 同文件、插入行及其后续 issue 行号 +1（因为插入了一行注释）
     * 2) 重新扫描文件中的 @ai-ignore 覆盖范围并给 issue 打 ignored 标记
     * 3) 立即刷新 TreeView，并清理旧高亮，避免高亮停留在过期行号
     *
     * 说明：本方法不触发 AI，不会重新走审查引擎，仅做面板内状态同步。
     */
    async syncAfterIssueIgnore(params: { filePath: string; insertedLine: number }): Promise<void> {
        const currentResult = this.provider.getCurrentResult();
        if (!currentResult) {
            return;
        }
        const normalizedTarget = path.normalize(params.filePath);
        const ignoredMeta = await this.collectIgnoredLineMeta(params.filePath);

        const mapIssues = (issues: ReviewIssue[]): ReviewIssue[] =>
            issues.map(issue => {
                const normalizedIssuePath = path.normalize(issue.file);
                if (normalizedIssuePath !== normalizedTarget) {
                    return issue;
                }
                const shiftedLine = issue.line >= params.insertedLine ? issue.line + 1 : issue.line;
                const ignored = ignoredMeta.ignoredLines.has(shiftedLine);
                return {
                    ...issue,
                    line: shiftedLine,
                    ignored,
                    ignoreReason: ignored ? ignoredMeta.reasonByLine.get(shiftedLine) : undefined,
                };
            });

        const nextResult: ReviewResult = {
            ...currentResult,
            errors: mapIssues(currentResult.errors),
            warnings: mapIssues(currentResult.warnings),
            info: mapIssues(currentResult.info),
        };

        this.clearHighlight();
        this.provider.updateResult(nextResult, this.provider.getStatus());
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
     * 编辑期本地同步：按文本变更重映射 issue 行号并标记 stale。
     *
     * 注意：
     * - 仅做 UI 层同步，不触发 AI。
     * - 检测到 @ai-ignore 注释插入时跳过（避免与 syncAfterIssueIgnore 双重偏移）。
     */
    private syncAfterDocumentChange = async (event: vscode.TextDocumentChangeEvent): Promise<void> => {
        if (!this.enableLocalRebase) {
            return;
        }
        if (event.document.uri.scheme !== 'file') {
            return;
        }
        if (!event.contentChanges.length) {
            return;
        }
        if (event.contentChanges.some(change => /@ai-ignore\b/i.test(change.text))) {
            return;
        }
        const currentResult = this.provider.getCurrentResult();
        if (!currentResult) {
            return;
        }
        const changedFilePath = path.normalize(event.document.uri.fsPath);
        const allIssues = [...currentResult.errors, ...currentResult.warnings, ...currentResult.info];
        if (!allIssues.some(issue => path.normalize(issue.file) === changedFilePath)) {
            return;
        }

        const changeImpactLines = event.contentChanges.reduce((sum, change) => {
            const removedLineCount = Math.max(0, change.range.end.line - change.range.start.line);
            const addedLineCount = (change.text.match(/\n/g) ?? []).length;
            return sum + Math.max(removedLineCount, addedLineCount) + 1;
        }, 0);
        const onlyMarkStale = changeImpactLines > this.largeChangeLineThreshold;

        const rebaseLineByChanges = (line: number): number => {
            let rebased = line;
            for (const change of event.contentChanges) {
                const startLine = change.range.start.line + 1;
                const endLine = change.range.end.line + 1;
                const removedLineCount = Math.max(0, change.range.end.line - change.range.start.line);
                const addedLineCount = (change.text.match(/\n/g) ?? []).length;
                const delta = addedLineCount - removedLineCount;
                const isPureInsert = removedLineCount === 0 && addedLineCount > 0;

                if (rebased > endLine) {
                    rebased += delta;
                    continue;
                }
                if (isPureInsert && rebased === startLine) {
                    rebased += addedLineCount;
                    continue;
                }
                if (rebased >= startLine && rebased <= endLine) {
                    rebased = Math.max(1, startLine);
                }
            }
            return Math.max(1, rebased);
        };

        const markIssueStale = (issue: ReviewIssue): ReviewIssue => {
            if (onlyMarkStale) {
                return { ...issue, stale: true };
            }
            return {
                ...issue,
                line: rebaseLineByChanges(issue.line),
                stale: true,
            };
        };

        const mapIssues = (issues: ReviewIssue[]): ReviewIssue[] => issues.map(issue => {
            if (path.normalize(issue.file) !== changedFilePath) {
                return issue;
            }
            return markIssueStale(issue);
        });

        if (
            this.activeIssueForActions
            && path.normalize(this.activeIssueForActions.file) === changedFilePath
        ) {
            this.activeIssueForActions = markIssueStale(this.activeIssueForActions);
        }

        const nextResult: ReviewResult = {
            ...currentResult,
            errors: mapIssues(currentResult.errors),
            warnings: mapIssues(currentResult.warnings),
            info: mapIssues(currentResult.info),
        };
        this.provider.updateResult(nextResult, this.provider.getStatus(), '已同步位置（待复审）');

        if (
            this.lastHighlightedEditor
            && path.normalize(this.lastHighlightedEditor.document.uri.fsPath) === changedFilePath
            && this.activeIssueForActions
        ) {
            void this.highlightIssue(this.activeIssueForActions);
        }
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
            // #region agent log
            fetch('http://127.0.0.1:7249/ingest/6d65f76e-9264-4398-8f0e-449b589acfa2',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run-1',hypothesisId:'H4',location:'reviewPanel.ts:489',message:'highlight_issue_selected',data:{file:issue.file,line:issue.line,column:issue.column,hasAstRange:!!issue.astRange,astRange:issue.astRange??null},timestamp:Date.now()})}).catch(()=>{});
            // #endregion

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
                    // #region agent log
                    fetch('http://127.0.0.1:7249/ingest/6d65f76e-9264-4398-8f0e-449b589acfa2',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run-1',hypothesisId:'H5',location:'reviewPanel.ts:528',message:'ast_decoration_applied',data:{docLineCount:document.lineCount,astStartLine,astEndLine},timestamp:Date.now()})}).catch(()=>{});
                    // #endregion
                }
            }
            if (!issue.astRange) {
                // #region agent log
                fetch('http://127.0.0.1:7249/ingest/6d65f76e-9264-4398-8f0e-449b589acfa2',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run-1',hypothesisId:'H4',location:'reviewPanel.ts:531',message:'ast_decoration_skipped_no_ast_range',data:{file:issue.file,line:issue.line},timestamp:Date.now()})}).catch(()=>{});
                // #endregion
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
        if (issue.ignored) {
            md.appendMarkdown('\n\n状态: 已放行（@ai-ignore）');
            if (issue.ignoreReason) {
                md.appendMarkdown(`\n放行原因: ${issue.ignoreReason}`);
            }
        }
        if (issue.stale) {
            md.appendMarkdown('\n\n状态: 已同步位置（待复审，语义可能过期）');
        }
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
        md.appendMarkdown('[放行此条](command:agentreview.allowIssueIgnore) · [修复](command:agentreview.fixIssue)');
        return md;
    };

    /** 供「修复」等命令读取当前 Hover 对应的问题 */
    getActiveIssueForActions(): ReviewIssue | null {
        return this.activeIssueForActions;
    }

    /**
     * 收集当前文件中 @ai-ignore 的覆盖行与原因：
     * - 注释所在行：忽略
     * - 注释后的首个非空行：忽略（与 ReviewEngine.filterIgnoredIssues 保持一致）
     */
    private collectIgnoredLineMeta = async (filePath: string): Promise<IgnoreLineMeta> => {
        const meta: IgnoreLineMeta = {
            ignoredLines: new Set<number>(),
            reasonByLine: new Map<number, string>(),
        };
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            for (let i = 0; i < document.lineCount; i++) {
                const text = document.lineAt(i).text;
                if (!/@ai-ignore\b/i.test(text)) {
                    continue;
                }
                const line = i + 1;
                const reason = this.extractIgnoreReason(text);
                meta.ignoredLines.add(line);
                if (reason) {
                    meta.reasonByLine.set(line, reason);
                }
                let next = i + 1;
                while (next < document.lineCount && document.lineAt(next).text.trim().length === 0) {
                    next++;
                }
                if (next < document.lineCount) {
                    const nextLine = next + 1;
                    meta.ignoredLines.add(nextLine);
                    if (reason) {
                        meta.reasonByLine.set(nextLine, reason);
                    }
                }
            }
        } catch {
            // 本地同步阶段若读取失败，回退为“不打 ignored 标记”，避免影响正常编辑流程。
        }
        return meta;
    };

    /**
     * 从注释行提取 @ai-ignore 后的原因文本，兼容 //、#、<!-- -->、块注释等常见格式。
     */
    private extractIgnoreReason = (lineText: string): string | undefined => {
        const match = lineText.match(/@ai-ignore(?:\s*:\s*|\s+)?(.*)$/i);
        if (!match) {
            return undefined;
        }
        const cleaned = match[1]
            .replace(/-->\s*$/g, '')
            .replace(/\*\/\s*$/g, '')
            .trim();
        return cleaned.length > 0 ? cleaned : undefined;
    };

    dispose(): void {
        this.clearHighlight();
        this.highlightDecoration.dispose();
        this.errorHighlightDecoration.dispose();
        this.warningHighlightDecoration.dispose();
        this.infoHighlightDecoration.dispose();
        this.astHighlightDecoration.dispose();
        this.hoverProvider.dispose();
        this.documentChangeDisposable.dispose();
        this.selectionDisposable.dispose();
        this.treeView.dispose();
    }
}
