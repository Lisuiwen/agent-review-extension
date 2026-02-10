import * as path from 'path';
import { parse } from '@babel/parser';
import { parse as parseSfc } from '@vue/compiler-sfc';
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

export type AstFallbackReason =
    | 'unsupportedExt'
    | 'parseFailed'
    | 'maxFileLines'
    | 'maxNodeLines'
    | 'emptyResult';

export interface AffectedScopeWithDiagnostics {
    result: AffectedScopeResult | null;
    fallbackReason?: AstFallbackReason;
}

/**
 * 获取变更影响的 AST 片段
 *
 * 支持：.js / .jsx / .ts / .tsx（整文件 Babel AST）；.vue（SFC 按 block 解析）。
 * .vue 策略：变更行落在哪个 block 就解析哪个 block；script/scriptSetup 用 Babel，template 用模板 AST
 * 仅做片段定位与截取，模板 AST 不参与规则引擎。
 * 若解析失败或不支持的语言，返回 null 以回退为 diff 片段。
 */
export const getAffectedScope = (
    filePath: string,
    content: string,
    fileDiff: FileDiff,
    options?: AstScopeOptions
): AffectedScopeResult | null => {
    return getAffectedScopeWithDiagnostics(filePath, content, fileDiff, options).result;
};

export const getAffectedScopeWithDiagnostics = (
    filePath: string,
    content: string,
    fileDiff: FileDiff,
    options?: AstScopeOptions
): AffectedScopeWithDiagnostics => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.vue') {
        return getAffectedScopeVueSfcWithDiagnostics(content, fileDiff, options);
    }
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        return { result: null, fallbackReason: 'unsupportedExt' };
    }

    if (!fileDiff?.hunks?.length) {
        return { result: null, fallbackReason: 'emptyResult' };
    }

    const lines = content.split('\n');
    if (options?.maxFileLines && lines.length > options.maxFileLines) {
        return { result: null, fallbackReason: 'maxFileLines' };
    }

    const changedLines = collectChangedLines(fileDiff);
    if (changedLines.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }

    let ast: any;
    try {
        ast = parse(content, {
            sourceType: 'module',
            plugins: ['typescript', 'jsx'],
            errorRecovery: true,
        });
    } catch {
        return { result: null, fallbackReason: 'parseFailed' };
    }

    const bestByLine = collectSmallestNodes(ast, changedLines);
    if (bestByLine.size === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
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
            return { result: null, fallbackReason: 'maxNodeLines' };
        }
        const source = lines.slice(normalizedStart - 1, normalizedEnd).join('\n');
        rawSnippets.push({ startLine: normalizedStart, endLine: normalizedEnd, source });
    }

    if (rawSnippets.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }

    // 去掉被其他片段完全包含的片段，避免同一段代码重复展示
    const snippets = rawSnippets.filter(
        (a) => !rawSnippets.some((b) => b !== a && b.startLine <= a.startLine && b.endLine >= a.endLine)
    );
    if (snippets.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }
    // 按文件行号排序，输出顺序与源码一致
    snippets.sort((a, b) => a.startLine !== b.startLine ? a.startLine - b.startLine : a.endLine - b.endLine);

    return { result: { snippets } };
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

/**
 * Vue SFC：按 block 解析，仅 script/scriptSetup/template；行号均为源文件行号。
 * 模板 AST 仅用于片段定位，不参与规则引擎。某 block 解析失败则仅该 block 降级为 diff。
 */
const getAffectedScopeVueSfcWithDiagnostics = (
    content: string,
    fileDiff: FileDiff,
    options?: AstScopeOptions
): AffectedScopeWithDiagnostics => {
    if (!fileDiff?.hunks?.length) {
        return { result: null, fallbackReason: 'emptyResult' };
    }
    const lines = content.split('\n');
    if (options?.maxFileLines && lines.length > options.maxFileLines) {
        return { result: null, fallbackReason: 'maxFileLines' };
    }
    const changedLines = collectChangedLines(fileDiff);
    if (changedLines.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }

    let descriptor: ReturnType<typeof parseSfc>['descriptor'];
    try {
        const result = parseSfc(content, { filename: 'anonymous.vue' });
        descriptor = result.descriptor;
        if (result.errors?.length && !descriptor.template && !descriptor.script && !descriptor.scriptSetup) {
            return { result: null, fallbackReason: 'parseFailed' };
        }
    } catch {
        return { result: null, fallbackReason: 'parseFailed' };
    }

    const allSnippets: AffectedScopeSnippet[] = [];

    const pushScriptBlockSnippets = (block: { content: string; loc: { start: { line: number }; end: { line: number } } } | null) => {
        if (!block?.content || !block.loc?.start?.line) return;
        const blockStartLine = block.loc.start.line;
        const blockEndLine = block.loc.end.line;
        const changedInBlock = changedLines.filter((line) => line >= blockStartLine && line <= blockEndLine);
        if (changedInBlock.length === 0) return;
        const relativeLines = changedInBlock.map((line) => line - blockStartLine + 1);
        let ast: any;
        try {
            ast = parse(block.content, {
                sourceType: 'module',
                plugins: ['typescript', 'jsx'],
                errorRecovery: true,
            });
        } catch {
            return;
        }
        const bestByLine = collectSmallestNodes(ast, relativeLines);
        const uniqueNodes = new Map<string, { startLine: number; endLine: number }>();
        for (const node of bestByLine.values()) {
            const loc = node?.loc;
            if (!loc?.start?.line || !loc?.end?.line) continue;
            const startLine = blockStartLine + loc.start.line - 1;
            const endLine = blockStartLine + loc.end.line - 1;
            const key = `${startLine}:${endLine}:${node.type}`;
            if (!uniqueNodes.has(key)) uniqueNodes.set(key, { startLine, endLine });
        }
        for (const { startLine, endLine } of uniqueNodes.values()) {
            const normalizedStart = Math.max(1, startLine);
            const normalizedEnd = Math.min(lines.length, endLine);
            const lineCount = normalizedEnd - normalizedStart + 1;
            if (options?.maxNodeLines && lineCount > options.maxNodeLines) continue;
            const source = lines.slice(normalizedStart - 1, normalizedEnd).join('\n');
            allSnippets.push({ startLine: normalizedStart, endLine: normalizedEnd, source });
        }
    };

    pushScriptBlockSnippets(descriptor.script ?? null);
    pushScriptBlockSnippets(descriptor.scriptSetup ?? null);

    const template = descriptor.template;
    if (template && !template.src && template.loc?.start?.line != null) {
        const blockStartLine = template.loc.start.line;
        const blockEndLine = template.loc.end.line;
        const changedInBlock = changedLines.filter((line) => line >= blockStartLine && line <= blockEndLine);
        if (changedInBlock.length > 0 && template.ast) {
            const bestByLine = collectSmallestTemplateNodes(template.ast, changedInBlock);
            const uniqueNodes = new Map<string, { startLine: number; endLine: number }>();
            for (const node of bestByLine.values()) {
                const loc = (node as any)?.loc;
                if (!loc?.start?.line || !loc?.end?.line) continue;
                const startLine = loc.start.line;
                const endLine = loc.end.line;
                const key = `${startLine}:${endLine}:${(node as any).type}`;
                if (!uniqueNodes.has(key)) uniqueNodes.set(key, { startLine, endLine });
            }
            for (const { startLine, endLine } of uniqueNodes.values()) {
                const normalizedStart = Math.max(1, startLine);
                const normalizedEnd = Math.min(lines.length, endLine);
                const lineCount = normalizedEnd - normalizedStart + 1;
                if (options?.maxNodeLines && lineCount > options.maxNodeLines) continue;
                const source = lines.slice(normalizedStart - 1, normalizedEnd).join('\n');
                allSnippets.push({ startLine: normalizedStart, endLine: normalizedEnd, source });
            }
        }
    }

    if (allSnippets.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }
    const rawSnippets = allSnippets;
    const snippets = rawSnippets.filter(
        (a) => !rawSnippets.some((b) => b !== a && b.startLine <= a.startLine && b.endLine >= a.endLine)
    );
    if (snippets.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }
    snippets.sort((a, b) => (a.startLine !== b.startLine ? a.startLine - b.startLine : a.endLine - b.endLine));
    return { result: { snippets } };
};

/**
 * Vue 模板 AST：遍历节点树，按变更行取最小包含节点；loc 为 compiler-sfc 提供的源文件行号。
 */
const collectSmallestTemplateNodes = (ast: any, changedLines: number[]): Map<number, any> => {
    const bestByLine = new Map<number, any>();
    const visit = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        const loc = node.loc;
        if (loc?.start?.line != null && loc?.end?.line != null) {
            const startLine = loc.start.line;
            const endLine = loc.end.line;
            for (const line of changedLines) {
                if (line < startLine || line > endLine) continue;
                const current = bestByLine.get(line);
                const newSpan = endLine - startLine;
                if (!current) {
                    bestByLine.set(line, node);
                    continue;
                }
                const currentLoc = current.loc;
                const currentSpan = currentLoc.end.line - currentLoc.start.line;
                if (newSpan <= currentSpan) bestByLine.set(line, node);
            }
        }
        const children = node.children;
        if (Array.isArray(children)) {
            children.forEach((child: any) => visit(child));
        }
        const branches = node.branches;
        if (Array.isArray(branches)) {
            branches.forEach((b: any) => visit(b));
        }
        if (node.codegenNode && typeof node.codegenNode === 'object') {
            visit(node.codegenNode);
        }
    };
    if (ast?.children) {
        ast.children.forEach((child: any) => visit(child));
    }
    return bestByLine;
};
