/**
 * 问题指纹（内容寻址）
 *
 * 用于误报管理：同一逻辑问题在插行/删行后仍能被识别为「已忽略」。
 * 指纹 = 规则 ID + 相对路径 + 语义锚点（问题行及上下文）的哈希，不依赖绝对行号。
 */

import * as path from 'path';
import * as crypto from 'crypto';
import type { ReviewIssue } from '../types/review';

/** 归一化单行：去首尾空白、连续空白压成单空格，不依赖缩进 */
export const normalizeLineForAnchor = (line: string): string =>
    line.trim().replace(/\s+/g, ' ');

/**
 * 取问题行前后若干行的归一化拼接，作为语义锚点上下文
 * @param lines 文件行数组（0-based 索引）
 * @param lineIndex 问题行索引（0-based）
 * @param halfWindow 前后各取几行，默认 2
 */
export const getContextWindowLines = (
    lines: string[],
    lineIndex: number,
    halfWindow = 2
): string => {
    const start = Math.max(0, lineIndex - halfWindow);
    const end = Math.min(lines.length - 1, lineIndex + halfWindow);
    const slice = lines.slice(start, end + 1).map(normalizeLineForAnchor);
    return slice.join(' ');
};

/**
 * 计算问题指纹：规则 + 相对路径 + 语义锚点（问题行 + 上下文）的 SHA-256 前 16 字符 hex
 * 无文件内容或行越界返回 ''
 */
export const computeIssueFingerprint = (
    issue: Pick<ReviewIssue, 'file' | 'line' | 'rule' | 'message'>,
    fileContent: string,
    workspaceRoot: string
): string => {
    if (!fileContent || !workspaceRoot) {
        return '';
    }
    const lines = fileContent.split(/\r?\n/);
    const lineIndex = issue.line - 1; // 1-based → 0-based
    if (lineIndex < 0 || lineIndex >= lines.length) {
        return '';
    }
    const relativePath = path.relative(workspaceRoot, issue.file);
    const normalizedRelative = path.normalize(relativePath).replace(/\\/g, '/');
    const problemLine = normalizeLineForAnchor(lines[lineIndex]);
    const context = getContextWindowLines(lines, lineIndex, 2);
    const anchor = [problemLine, context].filter(Boolean).join(' ');
    const payload = [issue.rule, normalizedRelative, anchor].join('\n');
    const hash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    return hash.slice(0, 16);
};
