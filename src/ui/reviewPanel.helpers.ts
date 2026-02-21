/**
 * 审查面板纯函数辅助
 *
 * 从 reviewPanel 中抽出的无状态函数：范围合并、去重、结果规范化、行范围判断等。
 * 供 ReviewPanel 调用，保持主文件只做 UI 与流程编排。
 */

import * as path from 'path';
import type { ReviewResult, ReviewIssue } from '../types/review';
import type { StaleScopeHint, ReviewedRange } from './reviewPanel.types';
import { IssueDeduplicator } from '../core/issueDeduplicator';

/** 从 ReviewResult 合并出全部 issues（errors + warnings + info） */
export const getAllIssuesFromResult = (result: ReviewResult): ReviewIssue[] => [
    ...result.errors,
    ...result.warnings,
    ...result.info,
];

/** 归并、排序 StaleScopeHint，相邻或重叠范围合并为一段 */
export const mergeScopeHints = (rawHints: StaleScopeHint[]): StaleScopeHint[] => {
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

/** 按 file/line/column/rule/severity/message/reason/fingerprint 精确去重 */
export const deduplicateIssues = (issues: ReviewIssue[]): ReviewIssue[] => {
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
        if (seen.has(key)) continue;
        seen.add(key);
        deduplicated.push(issue);
    }
    return deduplicated;
};

/** 将 issues 按 severity 拆成 errors/warnings/info 并组装为 ReviewResult */
export const buildResultFromIssues = (issues: ReviewIssue[]): ReviewResult => {
    const errors = issues.filter(issue => issue.severity === 'error');
    const warnings = issues.filter(issue => issue.severity === 'warning');
    const info = issues.filter(issue => issue.severity === 'info');
    return {
        passed: errors.length === 0,
        errors,
        warnings,
        info,
    };
};

/**
 * 对当前结果做展示前规范化：精确去重 + AI 邻近相似去重，再按 severity 重组。
 */
export const normalizeResultForDisplay = (result: ReviewResult): ReviewResult => {
    const allIssues = getAllIssuesFromResult(result);
    const exactDeduplicated = deduplicateIssues(allIssues);
    const similarityDeduplicated = IssueDeduplicator.dedupeAiIssuesByProximityAndSimilarity(exactDeduplicated, {
        lineWindow: 2,
        similarityThreshold: 0.42,
        sameSeverityPick: 'latest',
    });
    return buildResultFromIssues(similarityDeduplicated);
};

/** 规范化并合并已复审行范围（排序、相邻合并） */
export const normalizeReviewedRanges = (ranges: ReviewedRange[]): ReviewedRange[] => {
    if (ranges.length === 0) {
        return [];
    }
    const normalized = ranges
        .map(range => {
            const startLine = Math.max(1, Math.floor(range.startLine));
            const endLine = Math.max(startLine, Math.floor(range.endLine));
            return { startLine, endLine };
        })
        .sort((a, b) =>
            a.startLine === b.startLine
                ? a.endLine - b.endLine
                : a.startLine - b.startLine
        );
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

/** 判断行号是否落在已复审范围内 */
export const isLineInReviewedRanges = (line: number, reviewedRanges: ReviewedRange[]): boolean => {
    if (reviewedRanges.length === 0) return false;
    const normalizedLine = Math.max(1, Math.floor(line));
    return reviewedRanges.some(r => normalizedLine >= r.startLine && normalizedLine <= r.endLine);
};

/** 判断两个问题是否为同一条（file/line/column/rule/severity 一致），供 Panel 与 Provider 复用 */
export const isSameIssue = (a: ReviewIssue, b: ReviewIssue): boolean =>
    path.normalize(a.file) === path.normalize(b.file) &&
    a.line === b.line &&
    a.column === b.column &&
    a.rule === b.rule &&
    a.severity === b.severity;
