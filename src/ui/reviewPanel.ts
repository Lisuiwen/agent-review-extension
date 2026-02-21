/**
 * 审查结果面板
 *
 * 1. ReviewPanel: 对外暴露 showReviewResult、applyFileReviewPatch、configureLocalRebase 等 API
 * 2. ReviewPanelProvider、ReviewTreeItem 由子模块实现，本文件仅 re-export 以保持对外 API 不变
 *
 * - 根节点：显示审查状态和统计
 *     - 文件节点：按文件分组显示问题
 *       - 问题节点：具体的问题项，点击可跳转到代码位置
 *
 * 使用示例：
 * const reviewPanel = new ReviewPanel(context);
 * reviewPanel.showReviewResult(result);
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { ReviewResult, ReviewIssue } from '../types/review';
import { ReviewPanelProvider } from './reviewPanelProvider';
import type { StaleScopeHint } from './reviewPanel.types';
import { isAiIssue } from './reviewPanel.types';
import {
    getAllIssuesFromResult,
    mergeScopeHints,
    normalizeResultForDisplay,
    normalizeReviewedRanges,
    isLineInReviewedRanges,
    buildResultFromIssues,
    isSameIssue,
} from './reviewPanel.helpers';
import { collectIgnoredLineMeta } from './reviewPanel.ignoreMeta';

export { ReviewTreeItem } from './reviewTreeItem';
export { ReviewPanelProvider } from './reviewPanelProvider';

/** 创建整行高亮装饰，供 Panel 统一使用 */
const createLineHighlightDecoration = (bgKey: string, borderKey: string): vscode.TextEditorDecorationType =>
    vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor(bgKey),
        border: '1px solid',
        borderColor: new vscode.ThemeColor(borderKey),
    });

export class ReviewPanel {
    private treeView: vscode.TreeView<import('./reviewTreeItem').ReviewTreeItem>;
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
    private treeViewVisibilityDisposable: vscode.Disposable;
    private activeEditorChangeDisposable: vscode.Disposable;
    private activeIssueForActions: ReviewIssue | null = null;
    private enableLocalRebase = true;
    private largeChangeLineThreshold = 40;

    constructor(context: vscode.ExtensionContext) {
        this.provider = new ReviewPanelProvider(context);
        this.treeView = vscode.window.createTreeView('agentReview.results', {
            treeDataProvider: this.provider,
            showCollapseAll: true
        });

        this.highlightDecoration = createLineHighlightDecoration('editor.lineHighlightBackground', 'editor.lineHighlightBorder');
        this.errorHighlightDecoration = createLineHighlightDecoration('editorError.background', 'errorForeground');
        this.warningHighlightDecoration = createLineHighlightDecoration('editorWarning.background', 'editorWarning.foreground');
        this.infoHighlightDecoration = createLineHighlightDecoration('editorInfo.background', 'editorInfo.foreground');
        this.astHighlightDecoration = createLineHighlightDecoration('editor.rangeHighlightBackground', 'editor.rangeHighlightBorder');

        this.hoverProvider = vscode.languages.registerHoverProvider(
            { scheme: 'file' },
            { provideHover: (document, position) => this.provideIssueHover(document, position) }
        );
        context.subscriptions.push(this.hoverProvider);

        this.selectionDisposable = this.treeView.onDidChangeSelection((event) => {
            const selectedItem = event.selection[0];
            if (!selectedItem || !selectedItem.issue) {
                this.clearHighlight();
                return;
            }
            void this.highlightIssue(selectedItem.issue, { reveal: true });
        });
        this.treeViewVisibilityDisposable = this.treeView.onDidChangeVisibility((event) => {
            if (!event.visible) this.clearHighlight();
        });

        const onDidChangeTextDocument = (vscode.workspace as unknown as {
            onDidChangeTextDocument?: (listener: (event: vscode.TextDocumentChangeEvent) => void) => vscode.Disposable;
        }).onDidChangeTextDocument;
        this.documentChangeDisposable = onDidChangeTextDocument
            ? onDidChangeTextDocument((event) => { void this.syncAfterDocumentChange(event); })
            : { dispose: () => {} };
        this.activeEditorChangeDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!this.lastHighlightedEditor) return;
            if (!editor) {
                this.clearHighlight();
                return;
            }
            const activePath = path.normalize(editor.document.uri.fsPath);
            const highlightedPath = path.normalize(this.lastHighlightedEditor.document.uri.fsPath);
            if (activePath !== highlightedPath) this.clearHighlight();
        });
        context.subscriptions.push(this.documentChangeDisposable);
        context.subscriptions.push(this.treeViewVisibilityDisposable);
        context.subscriptions.push(this.activeEditorChangeDisposable);
    }

    private syncTreeViewBadgeAndDescription(): void {
        const status = this.provider.getStatus();
        const result = this.provider.getCurrentResult();
        if (status === 'reviewing') {
            this.treeView.description = '$(sync~spin)';
            this.treeView.badge = { value: 0, tooltip: '审查中…' };
            return;
        }
        if (!result) {
            this.treeView.description = undefined;
            this.treeView.badge = undefined;
            return;
        }
        const e = result.errors.length;
        const w = result.warnings.length;
        const i = result.info.length;
        const tooltip = `错误: ${e}, 警告: ${w}, 信息: ${i}`;
        const bySeverity: Array<{ icon: string; count: number }> = [
            { icon: '$(error)', count: e },
            { icon: '$(warning)', count: w },
            { icon: '$(info)', count: i },
        ];
        const first = bySeverity.find(s => s.count > 0);
        if (first) {
            this.treeView.description = `${first.icon} ${first.count}`;
            this.treeView.badge = { value: first.count, tooltip };
        } else {
            this.treeView.description = undefined;
            this.treeView.badge = undefined;
        }
    }

    showReviewResult(
        result: ReviewResult,
        status: 'idle' | 'reviewing' | 'completed' | 'error' = 'completed',
        statusMessage = '',
        emptyStateHint = ''
    ): void {
        this.provider.updateResult(
            normalizeResultForDisplay(result),
            status,
            statusMessage,
            emptyStateHint
        );
        this.syncTreeViewBadgeAndDescription();
    }

    setStatus(status: 'idle' | 'reviewing' | 'completed' | 'error', statusMessage = ''): void {
        const currentResult = this.provider.getCurrentResult();
        this.provider.updateResult(currentResult, status, statusMessage);
        this.syncTreeViewBadgeAndDescription();
    }

    getStatus(): 'idle' | 'reviewing' | 'completed' | 'error' {
        return this.provider.getStatus();
    }

    getCurrentResult(): ReviewResult | null {
        return this.provider.getCurrentResult();
    }

    setSubStatus(statusMessage?: string): void {
        const currentResult = this.provider.getCurrentResult();
        this.provider.updateResult(currentResult, this.provider.getStatus(), statusMessage);
        this.syncTreeViewBadgeAndDescription();
    }

    clearFileStaleMarkers(filePath: string): void {
        const currentResult = this.provider.getCurrentResult();
        if (!currentResult) return;
        const normalizedTarget = path.normalize(filePath);
        let changed = false;
        const clearInIssues = (issues: ReviewIssue[]): ReviewIssue[] =>
            issues.map(issue => {
                if (path.normalize(issue.file) !== normalizedTarget || issue.stale !== true) return issue;
                changed = true;
                return { ...issue, stale: false };
            });
        const nextResult: ReviewResult = {
            ...currentResult,
            errors: clearInIssues(currentResult.errors),
            warnings: clearInIssues(currentResult.warnings),
            info: clearInIssues(currentResult.info),
        };
        if (!changed) return;
        if (
            this.activeIssueForActions &&
            path.normalize(this.activeIssueForActions.file) === normalizedTarget &&
            this.activeIssueForActions.stale === true
        ) {
            this.activeIssueForActions = { ...this.activeIssueForActions, stale: false };
        }
        this.provider.updateResult(nextResult, this.provider.getStatus());
        this.syncTreeViewBadgeAndDescription();
    }

    configureLocalRebase(options: { enabled?: boolean; largeChangeLineThreshold?: number }): void {
        if (options.enabled !== undefined) this.enableLocalRebase = options.enabled;
        if (
            typeof options.largeChangeLineThreshold === 'number' &&
            Number.isFinite(options.largeChangeLineThreshold) &&
            options.largeChangeLineThreshold > 0
        ) {
            this.largeChangeLineThreshold = Math.floor(options.largeChangeLineThreshold);
        }
    }

    isFileStale(filePath: string): boolean {
        const result = this.provider.getCurrentResult();
        if (!result) return false;
        const normalizedTarget = path.normalize(filePath);
        const allIssues = getAllIssuesFromResult(result);
        return allIssues.some(issue => path.normalize(issue.file) === normalizedTarget && issue.stale === true);
    }

    getStaleScopeHints(filePath: string): Array<{ startLine: number; endLine: number; source: 'ast' | 'line' }> {
        const result = this.provider.getCurrentResult();
        if (!result) return [];
        const normalizedTarget = path.normalize(filePath);
        const allIssues = getAllIssuesFromResult(result);
        const rawHints: StaleScopeHint[] = [];
        for (const issue of allIssues) {
            if (path.normalize(issue.file) !== normalizedTarget || issue.stale !== true) continue;
            if (issue.astRange) {
                const startLine = Math.max(1, Math.floor(issue.astRange.startLine));
                const endLine = Math.max(startLine, Math.floor(issue.astRange.endLine));
                rawHints.push({ startLine, endLine, source: 'ast' });
                continue;
            }
            const line = Math.max(1, Math.floor(issue.line));
            rawHints.push({ startLine: line, endLine: line, source: 'line' });
        }
        if (rawHints.length === 0) return [];
        return mergeScopeHints(rawHints);
    }

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
        const reviewedRanges = normalizeReviewedRanges(params.reviewedRanges ?? []);
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
            incomingBySeverity.errors.length +
            incomingBySeverity.warnings.length +
            incomingBySeverity.info.length;
        const keepTargetStaleIssues =
            params.replaceMode === 'stale_only' &&
            params.preserveStaleOnEmpty === true &&
            incomingIssueCount === 0;

        const shouldKeepExistingIssue = (issue: ReviewIssue): boolean => {
            const isTargetFile = path.normalize(issue.file) === normalizedTarget;
            if (!isTargetFile) return true;
            if (keepTargetStaleIssues) return true;
            if (params.replaceMode === 'all_in_file') return false;
            if (isAiIssue(issue) && reviewedMode === 'diff') {
                if (reviewedRanges.length === 0) return false;
                if (isLineInReviewedRanges(issue.line, reviewedRanges)) return false;
            }
            if (issue.stale !== true) return true;
            if (reviewedMode === 'full') return false;
            if (reviewedRanges.length === 0) return true;
            return !isLineInReviewedRanges(issue.line, reviewedRanges);
        };
        const mergedIssues = [
            ...incomingBySeverity.errors,
            ...currentResult.errors.filter(shouldKeepExistingIssue),
            ...incomingBySeverity.warnings,
            ...currentResult.warnings.filter(shouldKeepExistingIssue),
            ...incomingBySeverity.info,
            ...currentResult.info.filter(shouldKeepExistingIssue),
        ];
        const nextResult = normalizeResultForDisplay(buildResultFromIssues(mergedIssues));
        this.clearHighlight();
        this.provider.updateResult(
            nextResult,
            params.status ?? this.provider.getStatus(),
            params.statusMessage,
            params.emptyStateHint
        );
        this.syncTreeViewBadgeAndDescription();
    }

    async syncAfterIssueIgnore(params: { filePath: string; insertedLine: number }): Promise<void> {
        const currentResult = this.provider.getCurrentResult();
        if (!currentResult) return;
        const normalizedTarget = path.normalize(params.filePath);
        const ignoredMeta = await collectIgnoredLineMeta(params.filePath);
        const mapIssues = (issues: ReviewIssue[]): ReviewIssue[] =>
            issues.map(issue => {
                const normalizedIssuePath = path.normalize(issue.file);
                if (normalizedIssuePath !== normalizedTarget) return issue;
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
        this.syncTreeViewBadgeAndDescription();
    }

    reveal(): void {
        this.provider.refresh();
        this.syncTreeViewBadgeAndDescription();
    }

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

    private syncAfterDocumentChange = async (event: vscode.TextDocumentChangeEvent): Promise<void> => {
        if (!this.enableLocalRebase || event.document.uri.scheme !== 'file' || !event.contentChanges.length) return;
        if (event.contentChanges.some(change => /@ai-ignore\b/i.test(change.text))) return;
        const currentResult = this.provider.getCurrentResult();
        if (!currentResult) return;
        const changedFilePath = path.normalize(event.document.uri.fsPath);
        const allIssues = [...currentResult.errors, ...currentResult.warnings, ...currentResult.info];
        if (!allIssues.some(issue => path.normalize(issue.file) === changedFilePath)) return;

        const getChangeDelta = (change: vscode.TextDocumentContentChangeEvent) => {
            const removed = Math.max(0, change.range.end.line - change.range.start.line);
            const added = (change.text.match(/\n/g) ?? []).length;
            const startLine1 = change.range.start.line + 1;
            const endLine1 = change.range.end.line + 1;
            return { removed, added, delta: added - removed, startLine1, endLine1 };
        };
        const changeImpactLines = event.contentChanges.reduce((sum, change) => {
            const { removed, added } = getChangeDelta(change);
            return sum + Math.max(removed, added) + 1;
        }, 0);
        const onlyMarkStale = changeImpactLines > this.largeChangeLineThreshold;
        const affectedRanges = event.contentChanges.map(change => {
            const { removed, added, startLine1, endLine1 } = getChangeDelta(change);
            const isPureInsert = removed === 0 && added > 0;
            return isPureInsert ? { startLine: startLine1, endLine: startLine1 } : { startLine: startLine1, endLine: Math.max(startLine1, endLine1) };
        });

        const intersectsAffectedRanges = (startLine: number, endLine: number): boolean => {
            const s = Math.max(1, Math.floor(startLine));
            const e = Math.max(s, Math.floor(endLine));
            return affectedRanges.some(r => s <= r.endLine && e >= r.startLine);
        };
        const isIssueAffected = (issue: ReviewIssue): boolean =>
            onlyMarkStale || (issue.astRange ? intersectsAffectedRanges(issue.astRange.startLine, issue.astRange.endLine) : intersectsAffectedRanges(issue.line, issue.line));
        const rebaseLineByChanges = (line: number): number => {
            let rebased = line;
            for (const change of event.contentChanges) {
                const { removed, added, delta, startLine1, endLine1 } = getChangeDelta(change);
                const isPureInsert = removed === 0 && added > 0;
                if (rebased > endLine1) rebased += delta;
                else if (isPureInsert && rebased === startLine1) rebased += added;
                else if (rebased >= startLine1 && rebased <= endLine1) rebased = Math.max(1, startLine1);
            }
            return Math.max(1, rebased);
        };
        const markIssueStale = (issue: ReviewIssue): ReviewIssue => {
            const affected = isIssueAffected(issue);
            if (onlyMarkStale) return { ...issue, stale: true };
            const rebasedLine = rebaseLineByChanges(issue.line);
            const rebasedAstRange = issue.astRange
                ? (() => {
                    const rebasedStart = rebaseLineByChanges(issue.astRange.startLine);
                    const rebasedEnd = rebaseLineByChanges(issue.astRange.endLine);
                    return {
                        startLine: Math.min(rebasedStart, rebasedEnd),
                        endLine: Math.max(rebasedStart, rebasedEnd),
                    };
                })()
                : undefined;
            return {
                ...issue,
                line: rebasedLine,
                astRange: rebasedAstRange,
                stale: affected ? true : issue.stale,
            };
        };
        const mapIssues = (issues: ReviewIssue[]): ReviewIssue[] =>
            issues.map(issue => {
                if (path.normalize(issue.file) !== changedFilePath) return issue;
                return markIssueStale(issue);
            });
        if (
            this.activeIssueForActions &&
            path.normalize(this.activeIssueForActions.file) === changedFilePath
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
        this.syncTreeViewBadgeAndDescription();
    };

    private highlightIssue = async (issue: ReviewIssue, options?: { reveal?: boolean }): Promise<void> => {
        try {
            if (!this.treeView.visible) {
                this.clearHighlight();
                return;
            }
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(issue.file));
            const editor = await vscode.window.showTextDocument(document, {
                preserveFocus: false,
                preview: true
            });
            const safeLine = Math.min(Math.max(issue.line, 1), document.lineCount);
            const lineText = document.lineAt(safeLine - 1).text;
            if (options?.reveal) {
                const revealRange = new vscode.Range(safeLine - 1, 0, safeLine - 1, lineText.length);
                editor.revealRange(revealRange, vscode.TextEditorRevealType.InCenter);
            }
            this.clearHighlight();
            const lineRange = new vscode.Range(safeLine - 1, 0, safeLine - 1, lineText.length);
            if (issue.severity === 'error') {
                editor.setDecorations(this.errorHighlightDecoration, [lineRange]);
            } else if (issue.severity === 'warning') {
                editor.setDecorations(this.warningHighlightDecoration, [lineRange]);
            } else if (issue.severity === 'info') {
                editor.setDecorations(this.infoHighlightDecoration, [lineRange]);
            } else {
                editor.setDecorations(this.highlightDecoration, [lineRange]);
            }
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
        } catch {
            this.clearHighlight();
            vscode.window.showWarningMessage('无法打开文件进行定位，请检查文件路径是否有效');
        }
    };

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
            i => norm(i.file) === docPath && i.line === line1
        );
        const issue = issues[0];
        if (!issue) return undefined;
        this.activeIssueForActions = issue;
        return new vscode.Hover(this.buildIssueHoverMarkdown(issue));
    };

    private buildIssueHoverMarkdown = (issue: ReviewIssue): vscode.MarkdownString => {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        const severityLabel = issue.severity === 'error' ? '错' : issue.severity === 'warning' ? '警告' : '信息';
        md.appendMarkdown(`${severityLabel}: `);
        md.appendText(issue.message);
        if (issue.ignored) {
            md.appendMarkdown('\n\n状态: 已放行（@ai-ignore）');
            if (issue.ignoreReason) md.appendMarkdown(`\n放行原因: ${issue.ignoreReason}`);
        }
        if (issue.stale) {
            md.appendMarkdown('\n\n状态: 已同步位置待审，参考过期');
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
        md.appendMarkdown('[放行](command:agentreview.allowIssueIgnore)');
        if (issue.severity !== 'error') {
            md.appendMarkdown(' · [忽略](command:agentreview.ignoreIssue)');
        }
        return md;
    };

    getActiveIssueForActions(): ReviewIssue | null {
        return this.activeIssueForActions;
    }

    removeIssueFromList(issue: ReviewIssue): void {
        const wasActive = this.activeIssueForActions !== null && isSameIssue(this.activeIssueForActions, issue);
        const groupKey = this.provider.removeIssue(issue);
        if (wasActive) this.activeIssueForActions = null;
        if (groupKey) {
            setTimeout(() => {
                const node = this.provider.getCachedGroupNode(groupKey);
                if (node) void this.treeView.reveal(node);
            }, 0);
        }
        this.syncTreeViewBadgeAndDescription();
    }

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
        this.treeViewVisibilityDisposable.dispose();
        this.activeEditorChangeDisposable.dispose();
        this.treeView.dispose();
    }
}
