/**
 * API 响应 → ReviewIssue 转换
 *
 * 将 AI 返回的 issues 转为 ReviewIssue（含行列号校正、severity 映射）；依赖 types。
 */

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

/** 用 snippet 在内容中定位，返回 1-based 行列号；定位失败则用 fallback */
export function resolveIssuePositionFromSnippet(
    content: string,
    snippet: string | undefined,
    fallbackLine: number,
    fallbackColumn: number
): { line: number; column: number } {
    if (!snippet) return { line: fallbackLine, column: fallbackColumn };

    const normalizedContent = normalizeLineEndings(content);
    const normalizedSnippet = normalizeLineEndings(snippet);
    const snippetCandidates = [normalizedSnippet, normalizedSnippet.trim()].filter((v) => v.length > 0);

    let matchIndex = -1;
    for (const candidate of snippetCandidates) {
        matchIndex = normalizedContent.indexOf(candidate);
        if (matchIndex >= 0) break;
    }
    if (matchIndex < 0) return { line: fallbackLine, column: fallbackColumn };

    const contentBefore = normalizedContent.slice(0, matchIndex);
    const line = contentBefore.split('\n').length;
    const lastNewlineIndex = contentBefore.lastIndexOf('\n');
    const column = lastNewlineIndex === -1 ? matchIndex + 1 : matchIndex - lastNewlineIndex;
    return { line, column };
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
    options?: { useDiffLineNumbers?: boolean }
): ReviewIssue[] {
    const contentMap = new Map<string, string>(filesWithContent.map((f) => [f.path, f.content]));
    const action = config.action;
    const useDiffLineNumbers = options?.useDiffLineNumbers === true;

    return response.issues.map(({ file, line = 1, column = 1, snippet, message, severity }) => {
        const resolvedPosition = useDiffLineNumbers
            ? { line, column }
            : (() => {
                const content = contentMap.get(file);
                return content
                    ? resolveIssuePositionFromSnippet(content, snippet, line, column)
                    : { line, column };
            })();
        return {
            file,
            line: resolvedPosition.line,
            column: resolvedPosition.column,
            message,
            rule: 'ai_review',
            severity: mapSeverity(severity, action),
        };
    });
}
