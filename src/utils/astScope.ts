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
 * - mergeSnippetGapLines：相邻片段行间隔 ≤ 该值时合并为一段，默认 1；小于 0 时关闭合并。
 */
export interface AstScopeOptions {
    maxNodeLines?: number;
    maxFileLines?: number;
    mergeSnippetGapLines?: number;
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
 * 获取变更影响的 AST 片段的简便入口。
 * 支持：.js / .jsx / .ts / .tsx（整文件 Babel AST）；.vue（SFC 按 block 解析）。
 * 不返回 fallback 原因，仅返回片段结果；需要诊断信息时请用 getAffectedScopeWithDiagnostics。
 */
export const getAffectedScope = (
    filePath: string,
    content: string,
    fileDiff: FileDiff,
    options?: AstScopeOptions
): AffectedScopeResult | null => {
    return getAffectedScopeWithDiagnostics(filePath, content, fileDiff, options).result;
};

/**
 * 获取变更影响的 AST 片段，并返回 fallback 原因（用于诊断）。
 * JS/TS/JSX/TSX：整文件 Babel 解析 → 按变更行找最小/多行优先节点 → 去重、截取源码。
 * .vue：按 block 解析，script/scriptSetup 用 Babel，template 用模板 AST；仅做片段定位。
 */
export const getAffectedScopeWithDiagnostics = (
    filePath: string,
    content: string,
    fileDiff: FileDiff,
    options?: AstScopeOptions
): AffectedScopeWithDiagnostics => {
    // 1. 按扩展名分流：Vue SFC 走单独逻辑，其余仅支持 JS/TS/JSX/TSX
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.vue') {
        return getAffectedScopeVueSfcWithDiagnostics(content, fileDiff, options);
    }
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        return { result: null, fallbackReason: 'unsupportedExt' };
    }

    // 2. 必须有 diff hunks，否则无法知道「变更行」
    if (!fileDiff?.hunks?.length) {
        return { result: null, fallbackReason: 'emptyResult' };
    }

    const lines = content.split('\n');
    if (options?.maxFileLines && lines.length > options.maxFileLines) {
        return { result: null, fallbackReason: 'maxFileLines' };
    }

    // 3. 从 diff 中收集所有「新文件」中的变更行号（1-based）
    const changedLines = collectChangedLines(fileDiff);
    if (changedLines.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }

    // 4. 用 Babel 解析整文件得到 AST；失败则回退
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

    // 5. 对每个变更行，找到「覆盖该行且尽量小」的 AST 节点（多行节点优先，便于高亮）
    const bestByLine = collectSmallestNodes(ast, changedLines);
    if (bestByLine.size === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }

    // 6. 按 (startLine, endLine, type) 去重，避免同一节点因多行变更重复出现
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

    // 7. 将每个节点转为 AffectedScopeSnippet；超 maxNodeLines 时截断为前 maxNodeLines 行并继续，不回退整文件
    const rawSnippets: AffectedScopeSnippet[] = [];
    const maxNodeLines = options?.maxNodeLines;
    for (const { startLine, endLine } of uniqueNodes.values()) {
        const normalizedStart = Math.max(1, startLine);
        let normalizedEnd = Math.min(lines.length, endLine);
        const lineCount = normalizedEnd - normalizedStart + 1;
        if (maxNodeLines != null && lineCount > maxNodeLines) {
            normalizedEnd = normalizedStart + maxNodeLines - 1;
        }
        const source = lines.slice(normalizedStart - 1, normalizedEnd).join('\n');
        rawSnippets.push({ startLine: normalizedStart, endLine: normalizedEnd, source });
    }

    if (rawSnippets.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }

    // 8. 去掉被其他片段完全包含的片段，避免同一段代码重复展示
    const snippets = rawSnippets.filter(
        (a) => !rawSnippets.some((b) => b !== a && b.startLine <= a.startLine && b.endLine >= a.endLine)
    );
    if (snippets.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }
    // 9. 按文件行号排序，输出顺序与源码一致
    snippets.sort((a, b) => a.startLine !== b.startLine ? a.startLine - b.startLine : a.endLine - b.endLine);

    // 10. 相邻片段合并（间隔 ≤ K 则合并，K<0 关闭）
    const merged = mergeAdjacentSnippets(snippets, lines, options?.mergeSnippetGapLines ?? 1);
    return { result: { snippets: merged } };
};

/**
 * 将已排序的相邻片段合并：两段间隔（后段 startLine - 前段 endLine - 1）≤ gapLines 时合并为一段。
 * gapLines < 0 时不合并，原样返回。合并后的 source 从 lines 按 startLine/endLine 重新截取。
 */
const mergeAdjacentSnippets = (
    snippets: AffectedScopeSnippet[],
    lines: string[],
    gapLines: number
): AffectedScopeSnippet[] => {
    if (gapLines < 0 || snippets.length <= 1) {
        return snippets;
    }
    const merged: AffectedScopeSnippet[] = [];
    let current = { ...snippets[0] };
    for (let i = 1; i < snippets.length; i++) {
        const next = snippets[i];
        const gap = next.startLine - current.endLine - 1;
        if (gap <= gapLines) {
            current.endLine = Math.max(current.endLine, next.endLine);
            current.source = lines.slice(current.startLine - 1, current.endLine).join('\n');
        } else {
            merged.push(current);
            current = { ...next };
        }
    }
    merged.push(current);
    return merged;
};

/**
 * 从统一 diff 的 hunks 中收集「新文件」里所有变更行的行号（1-based）。
 * 每个 hunk 的 newStart + 0..newCount-1 即为该 hunk 在新文件中的行号。
 */
const collectChangedLines = (fileDiff: FileDiff): number[] => {
    const lines = new Set<number>();
    for (const hunk of fileDiff.hunks) {
        for (let i = 0; i < hunk.newCount; i++) {
            lines.add(hunk.newStart + i);
        }
    }
    return Array.from(lines.values()).sort((a, b) => a - b);
};

/**
 * 遍历 Babel AST，对每一行变更行号，记录「覆盖该行」且按 pickBetterNode 策略选出的最佳节点。
 * 返回 Map<行号, 节点>，同一行可能被多个节点覆盖，这里只保留一个「更合适」的（多行优先、再按跨度更小）。
 */
const collectSmallestNodes = (ast: any, changedLines: number[]): Map<number, any> => {
    const bestByLine = new Map<number, any>();
    /**
     * 选择更合适的 AST 节点用于“范围高亮”：
     * - 优先选择多行节点（如函数体）以提供稳定的上下文范围；
     * - 若都为单行或都为多行，再按“更小跨度”选择，避免范围过大。
     *
     * 背景：纯“最小节点”策略容易退化为单行表达式，导致 AST 浅色高亮看起来像没生效。
     */
    const pickBetterNode = (current: any, candidate: any): any => {
        if (!current) {
            return candidate;
        }
        const currentStart = current?.loc?.start?.line;
        const currentEnd = current?.loc?.end?.line;
        const candidateStart = candidate?.loc?.start?.line;
        const candidateEnd = candidate?.loc?.end?.line;
        if (!currentStart || !currentEnd || !candidateStart || !candidateEnd) {
            return current;
        }
        const currentSpan = currentEnd - currentStart;
        const candidateSpan = candidateEnd - candidateStart;
        const currentMultiLine = currentSpan > 0;
        const candidateMultiLine = candidateSpan > 0;
        if (currentMultiLine !== candidateMultiLine) {
            return candidateMultiLine ? candidate : current;
        }
        return candidateSpan <= currentSpan ? candidate : current;
    };
    /** 递归遍历 AST：对每个有 loc 的节点，若覆盖某条变更行则参与 pickBetterNode 竞争 */
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
                    // 该节点覆盖的变更行都尝试用当前节点更新 bestByLine
                    for (const line of changedLines) {
                        if (line < startLine || line > endLine) {
                            continue;
                        }
                        const current = bestByLine.get(line);
                        bestByLine.set(line, pickBetterNode(current, node));
                    }
                }
            }
        }
        // 递归子属性（跳过 loc，避免重复）
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

    // 用 @vue/compiler-sfc 解析 SFC，得到 descriptor（script / scriptSetup / template 等）
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

    /**
     * 处理单个 script / scriptSetup block：只关心变更行落在该 block 内的情况，
     * 用 block 内相对行号做 Babel AST 的 collectSmallestNodes，再把得到的行号映射回源文件绝对行号并写入 allSnippets。
     */
    const pushScriptBlockSnippets = (block: { content: string; loc: { start: { line: number }; end: { line: number } } } | null) => {
        if (!block?.content || !block.loc?.start?.line) return;
        const blockStartLine = block.loc.start.line;
        const blockEndLine = block.loc.end.line;
        const changedInBlock = changedLines.filter((line) => line >= blockStartLine && line <= blockEndLine);
        if (changedInBlock.length === 0) return;
        // Babel 解析的是 block.content，行号从 1 开始，故转为「block 内相对行号」
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
            // 相对行号转回源文件绝对行号
            const startLine = blockStartLine + loc.start.line - 1;
            const endLine = blockStartLine + loc.end.line - 1;
            const key = `${startLine}:${endLine}:${node.type}`;
            if (!uniqueNodes.has(key)) uniqueNodes.set(key, { startLine, endLine });
        }
        for (const { startLine, endLine } of uniqueNodes.values()) {
            const normalizedStart = Math.max(1, startLine);
            let normalizedEnd = Math.min(lines.length, endLine);
            const lineCount = normalizedEnd - normalizedStart + 1;
            if (options?.maxNodeLines != null && lineCount > options.maxNodeLines) {
                normalizedEnd = normalizedStart + options.maxNodeLines - 1;
            }
            const source = lines.slice(normalizedStart - 1, normalizedEnd).join('\n');
            allSnippets.push({ startLine: normalizedStart, endLine: normalizedEnd, source });
        }
    };

    pushScriptBlockSnippets(descriptor.script ?? null);
    pushScriptBlockSnippets(descriptor.scriptSetup ?? null);

    // template block：仅内联模板（非 src 引用），用模板 AST 按变更行取最小节点，行号已是源文件行号
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
                let normalizedEnd = Math.min(lines.length, endLine);
                const lineCount = normalizedEnd - normalizedStart + 1;
                if (options?.maxNodeLines != null && lineCount > options.maxNodeLines) {
                    normalizedEnd = normalizedStart + options.maxNodeLines - 1;
                }
                const source = lines.slice(normalizedStart - 1, normalizedEnd).join('\n');
                allSnippets.push({ startLine: normalizedStart, endLine: normalizedEnd, source });
            }
        }
    }

    if (allSnippets.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }
    // 去重：去掉被其他片段完全包含的
    const rawSnippets = allSnippets;
    const snippets = rawSnippets.filter(
        (a) => !rawSnippets.some((b) => b !== a && b.startLine <= a.startLine && b.endLine >= a.endLine)
    );
    if (snippets.length === 0) {
        return { result: null, fallbackReason: 'emptyResult' };
    }
    snippets.sort((a, b) => (a.startLine !== b.startLine ? a.startLine - b.startLine : a.endLine - b.endLine));
    const gapK = options?.mergeSnippetGapLines ?? 1;
    const merged = mergeAdjacentSnippets(snippets, lines, gapK);
    return { result: { snippets: merged } };
};

/**
 * Vue 模板 AST：遍历节点树，对每条变更行记录「覆盖该行且跨度最小」的节点。
 * loc 为 compiler-sfc 提供的源文件行号；策略是「跨度更小则替换」，与 JS/TS 的 pickBetterNode（多行优先）不同。
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
                // 模板节点选跨度更小的
                const currentLoc = current.loc;
                const currentSpan = currentLoc.end.line - currentLoc.start.line;
                if (newSpan <= currentSpan) bestByLine.set(line, node);
            }
        }
        // 模板 AST 子节点在 children / branches / codegenNode
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
