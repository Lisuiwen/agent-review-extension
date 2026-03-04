/**
 * API 响应 → ReviewIssue 转换
 *
 * 将 AI 返回的 issues 转为 ReviewIssue（含行列号校正、severity 映射）；依赖 types。
 */

import * as path from 'path';
import type { ReviewIssue } from '../types/review';
import type { AIReviewConfig, AIReviewResponse } from './aiReviewer.types';

/** 将配置 action 映射为 ReviewIssue 的 severity */
export function actionToSeverity(action: 'block_commit' | 'warning' | 'log'): 'error' | 'warning' | 'info' {
    switch (action) {
        case 'block_commit': return 'error';
        case 'log': return 'info';
        default: return 'warning';
    }
}

/** 统一换行符为 \\n，避免 Windows/Unix 行号偏差 */
export function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

type SnippetPositionCandidate = {
    line: number;
    column: number;
    index: number;
};

type DiffResolvedPosition = {
    line: number;
    column: number;
    confidence: 'high' | 'low';
};

const MAX_SNIPPET_CANDIDATES = 50;

const buildSnippetCandidates = (snippet: string | undefined): string[] => {
    if (!snippet) return [];
    const normalizedSnippet = normalizeLineEndings(snippet);
    const candidates = [normalizedSnippet, normalizedSnippet.trim()].filter(v => v.length > 0);
    return [...new Set(candidates)];
};

const resolveLineColumnByIndex = (content: string, index: number): { line: number; column: number } => {
    const contentBefore = content.slice(0, index);
    const line = contentBefore.split('\n').length;
    const lastNewlineIndex = contentBefore.lastIndexOf('\n');
    const column = lastNewlineIndex === -1 ? index + 1 : index - lastNewlineIndex;
    return { line, column };
};

const collectSnippetPositionCandidates = (
    content: string,
    snippet: string | undefined,
    maxCandidates = MAX_SNIPPET_CANDIDATES
): SnippetPositionCandidate[] => {
    const normalizedContent = normalizeLineEndings(content);
    const snippetCandidates = buildSnippetCandidates(snippet);
    if (snippetCandidates.length === 0) return [];

    const candidates: SnippetPositionCandidate[] = [];
    const seenIndices = new Set<number>();
    for (const candidate of snippetCandidates) {
        let fromIndex = 0;
        while (fromIndex < normalizedContent.length) {
            const matchIndex = normalizedContent.indexOf(candidate, fromIndex);
            if (matchIndex < 0) break;
            if (!seenIndices.has(matchIndex)) {
                seenIndices.add(matchIndex);
                const { line, column } = resolveLineColumnByIndex(normalizedContent, matchIndex);
                candidates.push({ line, column, index: matchIndex });
                if (candidates.length >= maxCandidates) return candidates;
            }
            fromIndex = matchIndex + Math.max(candidate.length, 1);
        }
    }
    return candidates;
};

const rankCandidate = (
    candidate: SnippetPositionCandidate,
    targetLine: number,
    targetColumn: number
): number =>
    Math.abs(candidate.line - targetLine) * 1000 + Math.abs(candidate.column - targetColumn);

const resolveIssuePositionForDiff = (params: {
    content?: string;
    snippet?: string;
    line: number;
    column: number;
    allowedLines?: Set<number>;
}): DiffResolvedPosition => {
    const fallback: DiffResolvedPosition = { line: params.line, column: params.column, confidence: 'low' };
    if (!params.content) return fallback;

    const rawCandidates = collectSnippetPositionCandidates(params.content, params.snippet);
    if (rawCandidates.length === 0) return fallback;

    const candidates = params.allowedLines?.size
        ? rawCandidates.filter(candidate => params.allowedLines!.has(candidate.line))
        : rawCandidates;
    if (candidates.length === 0) return fallback;

    const sorted = [...candidates].sort((left, right) => {
        const leftRank = rankCandidate(left, params.line, params.column);
        const rightRank = rankCandidate(right, params.line, params.column);
        if (leftRank !== rightRank) return leftRank - rightRank;
        if (left.line !== right.line) return left.line - right.line;
        return left.column - right.column;
    });
    const best = sorted[0];
    const bestScore = rankCandidate(best, params.line, params.column);
    const secondBest = sorted[1];
    const secondScore = secondBest ? rankCandidate(secondBest, params.line, params.column) : Number.POSITIVE_INFINITY;
    const confidence: 'high' | 'low' = secondScore === bestScore ? 'low' : 'high';
    return { line: best.line, column: best.column, confidence };
};

/** 用 snippet 在内容中定位，返回 1-based 行列号；定位失败则用 fallback */
export function resolveIssuePositionFromSnippet(
    content: string,
    snippet: string | undefined,
    fallbackLine: number,
    fallbackColumn: number
): { line: number; column: number } {
    const firstCandidate = collectSnippetPositionCandidates(content, snippet, 1)[0];
    if (!firstCandidate) return { line: fallbackLine, column: fallbackColumn };
    return { line: firstCandidate.line, column: firstCandidate.column };
}

/** 按配置 action 映射 API severity 为展示用 severity */
export function mapSeverity(
    severity: 'error' | 'warning' | 'info',
    action: 'block_commit' | 'warning' | 'log'
): 'error' | 'warning' | 'info' {
    if (action === 'block_commit') return severity === 'info' ? 'warning' : severity;
    if (action === 'warning') return severity === 'error' ? 'warning' : severity;
    return 'info';
}

/** 将 API 响应转为 ReviewIssue 列表；useDiffLineNumbers 为 true 时直接用 API 行号 */
export function transformToReviewIssues(
    config: AIReviewConfig,
    response: AIReviewResponse,
    filesWithContent: Array<{ path: string; content: string }>,
    options?: {
        useDiffLineNumbers?: boolean;
        allowedLinesByFile?: Map<string, Set<number>>;
    }
): ReviewIssue[] {
    const contentMap = new Map<string, string>();
    for (const file of filesWithContent) {
        contentMap.set(file.path, file.content);
        contentMap.set(path.normalize(file.path), file.content);
    }
    const action = config.action;
    const useDiffLineNumbers = options?.useDiffLineNumbers === true;
    const getAllowedLines = (filePath: string): Set<number> | undefined => {
        const normalizedPath = path.normalize(filePath);
        return options?.allowedLinesByFile?.get(normalizedPath) ?? options?.allowedLinesByFile?.get(filePath);
    };

    const transformed: ReviewIssue[] = [];
    for (const { file, line = 1, column = 1, snippet, message, severity } of response.issues) {
        const content = contentMap.get(file) ?? contentMap.get(path.normalize(file));
        const allowedLines = getAllowedLines(file);
        let resolvedLine = line;
        let resolvedColumn = column;
        let diffConfidence: 'high' | 'low' | undefined;

        if (useDiffLineNumbers) {
            const resolved = resolveIssuePositionForDiff({
                content,
                snippet,
                line,
                column,
                allowedLines,
            });
            resolvedLine = resolved.line;
            resolvedColumn = resolved.column;
            diffConfidence = resolved.confidence;
        } else if (content) {
            const resolved = resolveIssuePositionFromSnippet(content, snippet, line, column);
            resolvedLine = resolved.line;
            resolvedColumn = resolved.column;
        }

        const outOfAllowedRange = !!allowedLines?.size && !allowedLines.has(resolvedLine);
        if (useDiffLineNumbers && diffConfidence === 'low' && outOfAllowedRange) {
            continue;
        }

        transformed.push({
            file,
            line: resolvedLine,
            column: resolvedColumn,
            message,
            rule: 'ai_review',
            severity: mapSeverity(severity, action),
        });
    }
    return transformed;
}
