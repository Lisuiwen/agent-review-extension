/**
 * 审查内容片段构建（纯函数）
 *
 * 根据 diff / AST 生成带行号标注的文本，供 AI 审查使用；不依赖 AIReviewer 实例。
 */

import type { FileDiff } from '../utils/diffTypes';
import type { AffectedScopeResult } from '../utils/astScope';

/** 根据 FileDiff 构建带行号标注的变更片段；含 "# 行 N"，便于 AI 返回新文件行号 */
export function buildDiffSnippetForFile(filePath: string, fileDiff: FileDiff): string {
    const lines: string[] = [`文件: ${filePath}`, '以下为变更片段，行号为新文件中的行号。', ''];
    for (const hunk of fileDiff.hunks) {
        for (let i = 0; i < hunk.lines.length; i++) {
            const lineNum = hunk.newStart + i;
            lines.push(`# 行 ${lineNum}`);
            lines.push(hunk.lines[i]);
        }
        lines.push('');
    }
    return lines.join('\n');
}

/** 根据 AST 片段构建带行号标注的内容 */
export function buildAstSnippetForFile(filePath: string, result: AffectedScopeResult): string {
    return buildAstSnippetForSnippets(filePath, result.snippets);
}

/** 将多个 AST snippet 拼成带 "# 行 N" 的文本 */
export function buildAstSnippetForSnippets(
    filePath: string,
    snippets: AffectedScopeResult['snippets']
): string {
    const lines: string[] = [`文件: ${filePath}`, '以下为变更相关的 AST 片段，行号为新文件中的行号。', ''];
    for (const snippet of snippets) {
        lines.push(`# 行 ${snippet.startLine}`);
        lines.push(snippet.source);
        lines.push('');
    }
    return lines.join('\n');
}

/** 区分「当前审查代码」与「外部引用上下文」，降低“未定义”类误报 */
export function buildStructuredReviewContent(currentContent: string, referenceContext: string): string {
    return [
        '【当前审查代码】',
        currentContent,
        '',
        '【外部引用上下文（仅供参考）】',
        referenceContext,
    ].join('\n');
}
