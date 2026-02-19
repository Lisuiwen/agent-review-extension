/**
 * 问题过滤与 diagnostics 去重
 *
 * 按允许行过滤、标准化 diagnostics、与 Linter 结果去重、为 issue 附加 astRange；Logger 与打点通过参数传入。
 */

import * as path from 'path';
import type { ReviewIssue } from '../types/review';
import type { AffectedScopeResult } from '../utils/astScope';

export type DiagnosticItem = { line: number; message: string; range?: { startLine: number; endLine: number } };

/** 标准化路径 key 的 diagnostics 映射，便于后续比对 */
export function normalizeDiagnosticsMap(
    diagnosticsByFile?: Map<string, DiagnosticItem[]>
): Map<string, DiagnosticItem[]> {
    const normalized = new Map<string, DiagnosticItem[]>();
    if (!diagnosticsByFile || diagnosticsByFile.size === 0) return normalized;
    for (const [filePath, diagnostics] of diagnosticsByFile.entries()) {
        normalized.set(path.normalize(filePath), diagnostics);
    }
    return normalized;
}

/** 从全量 diagnostics 中挑出指定文件列表，减少提示词体积 */
export function pickDiagnosticsForFiles(
    diagnosticsByFile: Map<string, DiagnosticItem[]>,
    filePaths: string[]
): Map<string, DiagnosticItem[]> {
    if (diagnosticsByFile.size === 0) return diagnosticsByFile;
    const picked = new Map<string, DiagnosticItem[]>();
    for (const filePath of filePaths) {
        const normalizedPath = path.normalize(filePath);
        const diagnostics = diagnosticsByFile.get(normalizedPath);
        if (diagnostics?.length) picked.set(normalizedPath, diagnostics);
    }
    return picked;
}

/** 标准化消息文本，用于重复判断 */
export function normalizeMessageForCompare(msg: string): string {
    return msg
        .toLowerCase()
        .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 计算两条消息相似度 0~1；相等/包含为 1，否则按 token 交集比率 */
export function calculateMessageSimilarity(left: string, right: string): number {
    const normalizedLeft = normalizeMessageForCompare(left);
    const normalizedRight = normalizeMessageForCompare(right);
    if (!normalizedLeft || !normalizedRight) return 0;
    if (
        normalizedLeft === normalizedRight ||
        normalizedLeft.includes(normalizedRight) ||
        normalizedRight.includes(normalizedLeft)
    ) {
        return 1;
    }
    const leftTokens = new Set(normalizedLeft.split(' ').filter(Boolean));
    const rightTokens = new Set(normalizedRight.split(' ').filter(Boolean));
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
    const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    return intersection / Math.max(leftTokens.size, rightTokens.size);
}

const MESSAGE_SIMILARITY_THRESHOLD = 0.65;

/** 判断 AI issue 与本地 diagnostic 是否高度重复（消息相似 + 同行或范围重叠） */
export function isLikelyDuplicateWithDiagnostic(
    issue: ReviewIssue,
    diagnostic: DiagnosticItem
): boolean {
    const similarity = calculateMessageSimilarity(issue.message, diagnostic.message);
    if (similarity < MESSAGE_SIMILARITY_THRESHOLD) return false;
    const sameLine = diagnostic.line === issue.line;
    const astRange = issue.astRange;
    const diagnosticRange = diagnostic.range;
    const rangeOverlap =
        !!astRange &&
        !!diagnosticRange &&
        astRange.endLine >= diagnosticRange.startLine &&
        astRange.startLine <= diagnosticRange.endLine;
    return sameLine || rangeOverlap;
}

/** 仅保留在 allowedLinesByFile 中允许行上的 issue；非 diff 模式或无允许行时原样返回 */
export function filterIssuesByAllowedLines(
    issues: ReviewIssue[],
    options: {
        useDiffContent: boolean;
        allowedLinesByFile: Map<string, Set<number>>;
    },
    logger?: { debug: (msg: string) => void }
): ReviewIssue[] {
    if (!options.useDiffContent || options.allowedLinesByFile.size === 0) return issues;
    const before = issues.length;
    const filtered = issues.filter((issue) => {
        const allowed = options.allowedLinesByFile.get(path.normalize(issue.file));
        if (!allowed) return false;
        return allowed.has(issue.line);
    });
    if (before > filtered.length) logger?.debug('[diff_only] 已过滤非变更行问题');
    return filtered;
}

/** 为 issues 补充 astRange（与 reviewEngine.attachAstRanges 一致），供与 diagnostic range 重叠过滤使用 */
export function attachAstRangesForBatch(
    issues: ReviewIssue[],
    astSnippetsByFile?: Map<string, AffectedScopeResult>
): void {
    if (!astSnippetsByFile || issues.length === 0) return;
    let selectedSingleLineCount = 0;
    let selectedMultiLineCount = 0;
    let noAstResultCount = 0;
    let noCandidatesCount = 0;
    const samples: string[] = [];
    for (const issue of issues) {
        if (issue.astRange) continue;
        const astResult = astSnippetsByFile.get(path.normalize(issue.file)) ?? astSnippetsByFile.get(issue.file);
        if (!astResult?.snippets?.length) {
            noAstResultCount++;
            continue;
        }
        const candidates = astResult.snippets.filter((s) => issue.line >= s.startLine && issue.line <= s.endLine);
        if (candidates.length === 0) {
            noCandidatesCount++;
            continue;
        }
        const best = candidates.reduce((a, b) => ((a.endLine - a.startLine) <= (b.endLine - b.startLine) ? a : b));
        issue.astRange = { startLine: best.startLine, endLine: best.endLine };
        const span = best.endLine - best.startLine + 1;
        if (span <= 1) selectedSingleLineCount++;
        else selectedMultiLineCount++;
        if (samples.length < 3) {
            const candidateSample = candidates.slice(0, 3).map((item) => `${item.startLine}-${item.endLine}`).join(',');
            samples.push(`${issue.file}@${issue.line}|best=${best.startLine}-${best.endLine}|candidates=${candidateSample}`);
        }
    }
    // #region agent log
    fetch('http://127.0.0.1:7249/ingest/6d65f76e-9264-4398-8f0e-449b589acfa2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            runId: 'run-2',
            hypothesisId: 'N2',
            location: 'aiReviewer.issueFilter.ts:attachAstRangesForBatch',
            message: 'attach_ast_ranges_for_batch_summary',
            data: {
                issues: issues.length,
                selectedSingleLineCount,
                selectedMultiLineCount,
                noAstResultCount,
                noCandidatesCount,
                samples,
            },
            timestamp: Date.now(),
        }),
    }).catch(() => {});
    // #endregion
}

/** 移除与本地 diagnostics 高度重复的 AI 问题；若过滤后为 0 则回退保留原结果 */
export function filterIssuesByDiagnostics(
    issues: ReviewIssue[],
    diagnosticsByFile: Map<string, DiagnosticItem[]>,
    options: {
        logger?: { debug: (msg: string) => void; warn: (msg: string) => void };
        onOverdropFallback?: (data: { issuesBefore: number; diagnosticsFiles: number }) => void;
    } = {}
): ReviewIssue[] {
    if (diagnosticsByFile.size === 0) return issues;
    const before = issues.length;
    const filtered = issues.filter((issue) => {
        const diagnostics = diagnosticsByFile.get(path.normalize(issue.file));
        if (!diagnostics || diagnostics.length === 0) return true;
        return !diagnostics.some((d) => isLikelyDuplicateWithDiagnostic(issue, d));
    });
    if (before > 0 && filtered.length === 0) {
        options.logger?.warn('[diagnostics] 过滤后结果为 0，已回退保留本次 AI 结果');
        options.onOverdropFallback?.({ issuesBefore: before, diagnosticsFiles: diagnosticsByFile.size });
    } else if (before > filtered.length) {
        options.logger?.debug('[diagnostics] 已过滤与本地诊断高度重复的 AI 问题');
    }
    return filtered.length > 0 || before === 0 ? filtered : issues;
}
