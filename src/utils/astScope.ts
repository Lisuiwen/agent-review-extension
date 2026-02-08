import * as path from 'path';
import { parse } from '@babel/parser';
import type { FileDiff } from './diffTypes';

/**
 * 受影响的 AST 片段
 * 
 * startLine/endLine 均为新文件行号（1-based）
 */
export interface AffectedScopeSnippet {
    startLine: number;
    endLine: number;
    source: string;
}

/**
 * AST 片段输出结构
 */
export interface AffectedScopeResult {
    snippets: AffectedScopeSnippet[];
}

/**
 * AST 片段解析选项
 */
export interface AstScopeOptions {
    maxNodeLines?: number;
    maxFileLines?: number;
}

/**
 * 获取变更影响的 AST 片段（仅支持 JS/TS/JSX/TSX）
 * 
 * 若解析失败或不支持的语言，返回 null 以回退为 diff 片段
 */
export const getAffectedScope = (
    filePath: string,
    content: string,
    fileDiff: FileDiff,
    options?: AstScopeOptions
): AffectedScopeResult | null => {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        return null;
    }

    if (!fileDiff?.hunks?.length) {
        return null;
    }

    const lines = content.split('\n');
    if (options?.maxFileLines && lines.length > options.maxFileLines) {
        return null;
    }

    const changedLines = collectChangedLines(fileDiff);
    if (changedLines.length === 0) {
        return null;
    }

    let ast: any;
    try {
        ast = parse(content, {
            sourceType: 'module',
            plugins: ['typescript', 'jsx'],
            errorRecovery: true,
        });
    } catch {
        return null;
    }

    const bestByLine = collectSmallestNodes(ast, changedLines);
    if (bestByLine.size === 0) {
        return null;
    }

    const uniqueNodes = new Map<string, { startLine: number; endLine: number }>();
    for (const node of bestByLine.values()) {
        const loc = node?.loc;
        if (!loc?.start?.line || !loc?.end?.line) {
            continue;
        }
        const startLine = loc.start.line;
        const endLine = loc.end.line;
        const key = `${startLine}:${endLine}:${node.type}`;
        if (!uniqueNodes.has(key)) {
            uniqueNodes.set(key, { startLine, endLine });
        }
    }

    const rawSnippets: AffectedScopeSnippet[] = [];
    for (const { startLine, endLine } of uniqueNodes.values()) {
        const normalizedStart = Math.max(1, startLine);
        const normalizedEnd = Math.min(lines.length, endLine);
        const lineCount = normalizedEnd - normalizedStart + 1;
        if (options?.maxNodeLines && lineCount > options.maxNodeLines) {
            return null;
        }
        const source = lines.slice(normalizedStart - 1, normalizedEnd).join('\n');
        rawSnippets.push({ startLine: normalizedStart, endLine: normalizedEnd, source });
    }

    if (rawSnippets.length === 0) {
        return null;
    }

    // 去掉被其他片段完全包含的片段，避免同一段代码重复展示
    const snippets = rawSnippets.filter(
        (a) => !rawSnippets.some((b) => b !== a && b.startLine <= a.startLine && b.endLine >= a.endLine)
    );
    // 按文件行号排序，输出顺序与源码一致
    snippets.sort((a, b) => a.startLine !== b.startLine ? a.startLine - b.startLine : a.endLine - b.endLine);

    return { snippets };
};

const collectChangedLines = (fileDiff: FileDiff): number[] => {
    const lines = new Set<number>();
    for (const hunk of fileDiff.hunks) {
        for (let i = 0; i < hunk.newCount; i++) {
            lines.add(hunk.newStart + i);
        }
    }
    return Array.from(lines.values()).sort((a, b) => a - b);
};

const collectSmallestNodes = (ast: any, changedLines: number[]): Map<number, any> => {
    const bestByLine = new Map<number, any>();
    const visit = (node: any): void => {
        if (!node || typeof node !== 'object') {
            return;
        }
        if (Array.isArray(node)) {
            node.forEach(child => visit(child));
            return;
        }
        if (typeof node.type === 'string') {
            const loc = node.loc;
            if (loc?.start?.line && loc?.end?.line) {
                if (node.type === 'Program' || node.type === 'File') {
                    // 根节点覆盖整文件，跳过以避免返回整文件片段
                } else {
                const startLine = loc.start.line;
                const endLine = loc.end.line;
                for (const line of changedLines) {
                    if (line < startLine || line > endLine) {
                        continue;
                    }
                    const current = bestByLine.get(line);
                    const newSpan = endLine - startLine;
                    if (!current) {
                        bestByLine.set(line, node);
                        continue;
                    }
                    const currentSpan = current.loc.end.line - current.loc.start.line;
                    if (newSpan <= currentSpan) {
                        bestByLine.set(line, node);
                    }
                }
                }
            }
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc') {
                continue;
            }
            const value = (node as Record<string, unknown>)[key];
            if (value && typeof value === 'object') {
                visit(value);
            }
        }
    };
    visit(ast);
    return bestByLine;
};
