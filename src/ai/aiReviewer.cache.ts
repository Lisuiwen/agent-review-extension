/**
 * AI 审查器：请求哈希与响应缓存合并
 *
 * 请求哈希用于缓存与续写关联；续写时合并已有 issues 并去重，避免重复结果。
 */

import type { AIReviewResponse } from './aiReviewer.types';

/** 简单字符串哈希（用于请求指纹） */
export const simpleHash = (input: string): string => {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = (hash << 5) - hash + input.charCodeAt(i);
        hash |= 0;
    }
    return `${hash}`;
};

/** 根据请求文件列表生成哈希，用于缓存与续写关联 */
export const calculateRequestHash = (request: { files: Array<{ path: string; content: string }> }): string => {
    const raw = request.files.map(file => `${file.path}:${file.content}`).join('|');
    return simpleHash(raw);
};

/** 去重 issues，避免续写带来的重复结果（按 file|line|column|message） */
export const dedupeIssues = (issues: AIReviewResponse['issues']): AIReviewResponse['issues'] => {
    const seen = new Set<string>();
    return issues.filter(issue => {
        const key = `${issue.file}|${issue.line}|${issue.column}|${issue.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

/**
 * 将本次 response 与缓存中同 requestHash 的 response 合并，去重后写回缓存并返回。
 */
export const mergeCachedIssues = (
    requestHash: string,
    response: AIReviewResponse,
    isPartial: boolean,
    cache: Map<string, { response: AIReviewResponse; isPartial: boolean }>
): AIReviewResponse => {
    const existing = cache.get(requestHash);
    const mergedIssues = existing
        ? dedupeIssues([...existing.response.issues, ...response.issues])
        : dedupeIssues(response.issues);
    const mergedResponse: AIReviewResponse = { issues: mergedIssues };
    cache.set(requestHash, { response: mergedResponse, isPartial });
    return mergedResponse;
};
