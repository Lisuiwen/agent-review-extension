import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AffectedScopeResult } from './astScope';

/**
 * LSP 参考上下文构建选项
 *
 * 目标：
 * 1. 仅做浅层补全（最多若干定义），避免 token 爆炸
 * 2. 只作为 AI 的参考信息，不改变主审查片段
 */
/** 可选：收集「定义/引用」位置行号，供 hover 展示关联上下文行号用 */
export interface CollectLineRefs {
    definitions?: Array<{ file: string; line: number }>;
    usages?: Array<{ file: string; line: number }>;
}

export interface LspContextOptions {
    maxDefinitions?: number;
    linePadding?: number;
    maxChars?: number;
    /** 若传入则顺带收集定义位置（file+line），不增加 LSP 调用 */
    collectLineRefs?: CollectLineRefs;
}

type IdentifierOccurrence = {
    name: string;
    line: number;
    character: number;
};

const DEFAULT_MAX_DEFINITIONS = 5;
const DEFAULT_LINE_PADDING = 2;
const DEFAULT_MAX_CHARS = 4000;

const IDENTIFIER_REGEX = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
const JS_TS_KEYWORDS = new Set([
    'const', 'let', 'var', 'function', 'class', 'new', 'return', 'if', 'else', 'for', 'while',
    'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'import', 'from',
    'export', 'default', 'extends', 'implements', 'interface', 'type', 'public', 'private',
    'protected', 'readonly', 'static', 'async', 'await', 'true', 'false', 'null', 'undefined',
    'void', 'this', 'super', 'typeof', 'instanceof', 'in', 'of', 'as', 'get', 'set',
]);

/**
 * 从 AST 片段中提取标识符并通过 LSP 获取定义位置，拼成「外部引用上下文」。
 *
 * 注意：
 * - 这里的输出仅用于 AI 参考，不参与规则判定。
 * - 如果 LSP 不可用或解析失败，返回空字符串，不影响主流程。
 */
export const buildLspReferenceContext = async (
    filePath: string,
    snippets: AffectedScopeResult['snippets'],
    options?: LspContextOptions
): Promise<string> => {
    const maxDefinitions = options?.maxDefinitions ?? DEFAULT_MAX_DEFINITIONS;
    const linePadding = options?.linePadding ?? DEFAULT_LINE_PADDING;
    const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
    if (maxDefinitions <= 0 || snippets.length === 0) {
        return '';
    }

    // 获取当前文件的 vscode Uri 对象，用于后续调用 LSP（语言服务器协议）相关 API。
    // 注意：LSP API 需要通过 Uri 确定目标文件，对新手来说 fileUri 就是 VSCode 用来标识磁盘文件的对象
    const fileUri = vscode.Uri.file(filePath);
    const candidates = collectIdentifierOccurrences(snippets);
    if (candidates.length === 0) {
        return '';
    }

    const seenDefinitionKeys = new Set<string>();
    const fileCache = new Map<string, string[]>();
    const chunks: string[] = [];

    for (const occurrence of candidates) {
        if (chunks.length >= maxDefinitions) {
            break;
        }
        const definitions = await getDefinitionLocations(fileUri, occurrence.line, occurrence.character);
        if (definitions.length === 0) {
            continue;
        }

        const first = definitions[0];
        const targetPath = normalizeFsPath(first.uri.fsPath);
        const targetLine = first.range.start.line + 1;
        if (isThirdPartyOrLibPath(targetPath)) continue;
        const key = `${targetPath}:${targetLine}`;
        if (seenDefinitionKeys.has(key)) {
            continue;
        }
        seenDefinitionKeys.add(key);
        options?.collectLineRefs?.definitions?.push({ file: targetPath, line: targetLine });

        const snippet = await readLineSnippet(targetPath, targetLine, linePadding, fileCache);
        if (!snippet) {
            continue;
        }
        chunks.push(
            [
                `符号: ${occurrence.name}`,
                `定义: ${targetPath}:${targetLine}`,
                '代码:',
                snippet,
            ].join('\n')
        );
    }

    if (chunks.length === 0) {
        return '';
    }
    const joined = chunks.join('\n\n');
    return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}\n...(参考上下文已截断)`;
};

/** 调用方上下文选项：最多条数、总字符上限 */
const DEFAULT_MAX_USAGES = 5;
const DEFAULT_MAX_USAGES_CHARS = 3000;

/**
 * 为变更片段内符号补充「调用方」上下文，供 AI 参考。
 * 复用 collectIdentifierOccurrences，对每个 occurrence 调 getReferenceLocations，按 path:line 去重，限制条数与总字符。
 */
export const buildLspUsagesContext = async (
    filePath: string,
    snippets: AffectedScopeResult['snippets'],
    options?: { maxUsages?: number; maxChars?: number; collectLineRefs?: CollectLineRefs }
): Promise<string> => {
    const maxUsages = options?.maxUsages ?? DEFAULT_MAX_USAGES;
    const maxChars = options?.maxChars ?? DEFAULT_MAX_USAGES_CHARS;
    if (maxUsages <= 0 || snippets.length === 0) return '';

    const fileUri = vscode.Uri.file(filePath);
    const candidates = collectIdentifierOccurrences(snippets);
    const fileCache = new Map<string, string[]>();
    const seenKey = new Set<string>();
    const bySymbol: string[] = [];
    let totalUsages = 0;
    let totalChars = 0;

    for (const occurrence of candidates) {
        if (totalUsages >= maxUsages || totalChars >= maxChars) break;
        const refs = await getReferenceLocations(fileUri, occurrence.line, occurrence.character);
        const refBlocks: string[] = [];
        for (const ref of refs) {
            if (totalUsages >= maxUsages || totalChars >= maxChars) break;
            const targetPath = normalizeFsPath(ref.uri.fsPath);
            const line = ref.range.start.line + 1;
            if (isThirdPartyOrLibPath(targetPath)) continue;
            const key = `${targetPath}:${line}`;
            if (seenKey.has(key)) continue;
            seenKey.add(key);
            options?.collectLineRefs?.usages?.push({ file: targetPath, line });
            const snippet = await readLineSnippet(targetPath, line, 1, fileCache);
            if (!snippet) continue;
            refBlocks.push(`- ${targetPath}:${line}\n  ${snippet.replace(/\n/g, '\n  ')}`);
            totalUsages += 1;
            totalChars += (targetPath + snippet).length + 20;
        }
        if (refBlocks.length > 0) {
            bySymbol.push(`符号: ${occurrence.name}\n${refBlocks.join('\n')}`);
        }
    }

    if (bySymbol.length === 0) return '';
    const header = '## 调用方 (Usages)';
    const body = bySymbol.join('\n\n');
    const out = `${header}\n${body}`;
    return out.length <= maxChars ? out : `${out.slice(0, maxChars)}\n...(调用方上下文已截断)`;
};

const normalizeFsPath = (input: string): string => path.normalize(input);

/**
 * 判断是否为第三方/库文件，不纳入「关联上下文行号」且不送给 AI，避免噪声与 token 浪费。
 * - node_modules 内文件
 * - TypeScript 库声明如 lib.dom.d.ts、lib.es2015.d.ts
 */
const isThirdPartyOrLibPath = (filePath: string): boolean => {
    const normalized = path.normalize(filePath);
    if (/\bnode_modules\b/.test(normalized)) return true;
    const base = path.basename(normalized);
    return /^lib\.\w+\.d\.ts$/i.test(base);
};

/**
 * 从「受影响作用域」的代码片段里收集所有标识符的出现位置（名称 + 行 + 列）。
 *
 * 用途：供 buildLspReferenceContext / buildLspReferenceContextFromRefs 使用：
 * 先得到这些候选位置，再对每个位置调 LSP 的 definition/references，拼成外部定义或引用上下文给 AI 参考。
 *
 * 行为摘要：
 * - 用正则匹配 JS/TS 合法标识符（字母/数字/下划线/$），排除关键字（const、function 等）。
 * - 按「标识符名:绝对行号」去重，同一行同一名字只算一次，避免重复查 LSP。
 * - 返回的 character 为 1-based 列号，与 LSP Position 一致。
 */
const collectIdentifierOccurrences = (snippets: AffectedScopeResult['snippets']): IdentifierOccurrence[] => {
    const occurrences: IdentifierOccurrence[] = [];
    const seenNameAndLine = new Set<string>();

    for (const snippet of snippets) {
        const lines = snippet.source.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const absoluteLine = snippet.startLine + i;
            const lineText = lines[i];
            IDENTIFIER_REGEX.lastIndex = 0;
            let match: RegExpExecArray | null = null;
            while ((match = IDENTIFIER_REGEX.exec(lineText)) !== null) {
                const name = match[0];
                if (JS_TS_KEYWORDS.has(name)) {
                    continue;
                }
                const key = `${name}:${absoluteLine}`;
                if (seenNameAndLine.has(key)) {
                    continue;
                }
                seenNameAndLine.add(key);
                occurrences.push({
                    name,
                    line: absoluteLine,
                    character: match.index + 1,
                });
            }
        }
    }

    return occurrences;
};

const getDefinitionLocations = async (
    fileUri: vscode.Uri,
    line: number,
    character: number
): Promise<vscode.Location[]> => {
    try {
        const result = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
            'vscode.executeDefinitionProvider',
            fileUri,
            new vscode.Position(Math.max(0, line - 1), Math.max(0, character - 1))
        );
        if (!Array.isArray(result) || result.length === 0) {
            return [];
        }
        return result.map(item => {
            if ('targetUri' in item) {
                return new vscode.Location(item.targetUri, item.targetRange);
            }
            return item;
        });
    } catch {
        return [];
    }
};

/**
 * 获取符号的引用位置（调用方），供 buildLspUsagesContext 使用。
 * 内部调用 vscode.executeReferenceProvider；LocationLink 转为 Location。
 */
export const getReferenceLocations = async (
    fileUri: vscode.Uri,
    line: number,
    character: number
): Promise<vscode.Location[]> => {
    try {
        const result = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
            'vscode.executeReferenceProvider',
            fileUri,
            new vscode.Position(Math.max(0, line - 1), Math.max(0, character - 1))
        );
        if (!Array.isArray(result) || result.length === 0) {
            return [];
        }
        return result.map(item => {
            if ('targetUri' in item) {
                return new vscode.Location(item.targetUri, item.targetRange);
            }
            return item;
        });
    } catch {
        return [];
    }
};

const readLineSnippet = async (
    filePath: string,
    centerLine: number,
    linePadding: number,
    cache: Map<string, string[]>
): Promise<string> => {
    try {
        const normalized = normalizeFsPath(filePath);
        if (!cache.has(normalized)) {
            const content = await fs.promises.readFile(normalized, 'utf8');
            cache.set(normalized, content.split('\n'));
        }
        const lines = cache.get(normalized) ?? [];
        if (lines.length === 0) {
            return '';
        }
        const start = Math.max(1, centerLine - linePadding);
        const end = Math.min(lines.length, centerLine + linePadding);
        const result: string[] = [];
        for (let line = start; line <= end; line++) {
            result.push(`# 行 ${line}`);
            result.push(lines[line - 1]);
        }
        return result.join('\n');
    } catch {
        return '';
    }
};
