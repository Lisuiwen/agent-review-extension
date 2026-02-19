/**
 * 审查单元与批次划分
 *
 * 将带内容的文件打成 ReviewUnit、按 snippet 或文件数切批、估算字符数等；依赖 types 与 snippets。
 */

import * as path from 'path';
import type { FileDiff } from '../utils/diffTypes';
import type { AffectedScopeResult } from '../utils/astScope';
import type { AIReviewConfig, ReviewUnit, ReviewUnitSourceType } from './aiReviewer.types';
import {
    DEFAULT_AST_SNIPPET_BUDGET,
    DEFAULT_AST_CHUNK_STRATEGY,
    DEFAULT_BATCH_CONCURRENCY,
    DEFAULT_MAX_REQUEST_CHARS,
    DEFAULT_BATCH_SIZE,
} from './aiReviewer.types';
import { buildAstSnippetForSnippets } from './aiReviewer.snippets';

/** 从配置读取 AST 片段预算，非法时回退默认值 */
export function getAstSnippetBudget(config: AIReviewConfig | null): number {
    const raw = config?.ast_snippet_budget ?? DEFAULT_AST_SNIPPET_BUDGET;
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AST_SNIPPET_BUDGET;
    return Math.max(1, Math.floor(raw));
}

/** 从配置读取批处理并发数，限制 1～8 */
export function getBatchConcurrency(config: AIReviewConfig | null): number {
    const raw = config?.batch_concurrency ?? DEFAULT_BATCH_CONCURRENCY;
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BATCH_CONCURRENCY;
    return Math.max(1, Math.min(8, Math.floor(raw)));
}

/** 从配置读取单次请求最大字符数，最小 1000 */
export function getMaxRequestChars(config: AIReviewConfig | null): number {
    const raw = config?.max_request_chars ?? DEFAULT_MAX_REQUEST_CHARS;
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_REQUEST_CHARS;
    return Math.max(1000, Math.floor(raw));
}

/** 将数组按 batchSize 切分为多批 */
export function splitIntoBatches<T>(files: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < files.length; i += batchSize) {
        batches.push(files.slice(i, i + batchSize));
    }
    return batches;
}

/** 将 AST 片段按 budget 切块：contiguous=顺序每 budget 个一块；even=均分 */
export function chunkAstSnippets(
    snippets: AffectedScopeResult['snippets'],
    budget: number,
    strategy: NonNullable<AIReviewConfig['ast_chunk_strategy']>
): Array<AffectedScopeResult['snippets']> {
    if (snippets.length <= budget) return [snippets];
    if (strategy === 'contiguous') {
        const chunks: Array<AffectedScopeResult['snippets']> = [];
        for (let i = 0; i < snippets.length; i += budget) {
            chunks.push(snippets.slice(i, i + budget));
        }
        return chunks;
    }
    const chunks: Array<AffectedScopeResult['snippets']> = [];
    const groupCount = Math.ceil(snippets.length / budget);
    const baseSize = Math.floor(snippets.length / groupCount);
    const remainder = snippets.length % groupCount;
    let cursor = 0;
    for (let i = 0; i < groupCount; i++) {
        const size = baseSize + (i < remainder ? 1 : 0);
        const nextCursor = Math.min(snippets.length, cursor + size);
        chunks.push(snippets.slice(cursor, nextCursor));
        cursor = nextCursor;
    }
    return chunks.filter((chunk) => chunk.length > 0);
}

/** 按 snippet 权重将单元分组，每批权重不超过 budget */
export function splitUnitsBySnippetBudget(units: ReviewUnit[], snippetBudget: number): ReviewUnit[][] {
    const budget = Math.max(1, snippetBudget);
    const batches: ReviewUnit[][] = [];
    let current: ReviewUnit[] = [];
    let currentWeight = 0;
    for (const unit of units) {
        const weight = Math.max(1, unit.snippetCount);
        if (current.length > 0 && currentWeight + weight > budget) {
            batches.push(current);
            current = [];
            currentWeight = 0;
        }
        current.push(unit);
        currentWeight += weight;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

/** 将单元数组从中间一分为二 */
export function splitUnitsInHalf(units: ReviewUnit[]): [ReviewUnit[], ReviewUnit[]] {
    const mid = Math.ceil(units.length / 2);
    return [units.slice(0, mid), units.slice(mid)];
}

/** 统计 units 的 snippet 总数 */
export function countUnitSnippets(units: ReviewUnit[]): number {
    return units.reduce((sum, unit) => sum + Math.max(1, unit.snippetCount), 0);
}

/** 统计 astSnippetsByFile 中 snippet 总数 */
export function countAstSnippetMap(astSnippetsByFile?: Map<string, AffectedScopeResult>): number {
    if (!astSnippetsByFile || astSnippetsByFile.size === 0) return 0;
    let total = 0;
    for (const result of astSnippetsByFile.values()) total += result.snippets.length;
    return total;
}

/** 估算请求体大致字符数（路径+内容+固定开销） */
export function estimateRequestChars(files: Array<{ path: string; content: string }>): number {
    return files.reduce((sum, file) => sum + file.path.length + file.content.length + 32, 0);
}

export type BuildReviewUnitsOptions = {
    useAstSnippets: boolean;
    astSnippetsByFile?: Map<string, AffectedScopeResult>;
    useDiffMode: boolean;
    diffByFile?: Map<string, FileDiff>;
};

/** 将带内容的文件打成 ReviewUnit 数组；ast_snippet 模式按 chunk 拆成多单元，否则每文件一单元 */
export function buildReviewUnits(
    config: AIReviewConfig | null,
    validFiles: Array<{ path: string; content: string }>,
    options: BuildReviewUnitsOptions
): ReviewUnit[] {
    const units: ReviewUnit[] = [];
    const useAstSnippetBatching = options.useAstSnippets && config?.batching_mode === 'ast_snippet';
    const astSnippetBudget = getAstSnippetBudget(config);
    const astChunkStrategy = config?.ast_chunk_strategy ?? DEFAULT_AST_CHUNK_STRATEGY;
    let unitCounter = 0;

    for (const file of validFiles) {
        const normalizedPath = path.normalize(file.path);
        const astResult = options.astSnippetsByFile?.get(normalizedPath) ?? options.astSnippetsByFile?.get(file.path);

        if (useAstSnippetBatching && astResult?.snippets?.length) {
            const chunks = chunkAstSnippets(astResult.snippets, astSnippetBudget, astChunkStrategy);
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                unitCounter++;
                units.push({
                    unitId: `${file.path}#ast#${i + 1}#${unitCounter}`,
                    path: file.path,
                    content: buildAstSnippetForSnippets(file.path, chunk),
                    snippetCount: Math.max(1, chunk.length),
                    sourceType: 'ast',
                });
            }
            continue;
        }

        let snippetCount = 1;
        let sourceType: ReviewUnitSourceType = 'full';
        if (astResult?.snippets?.length) {
            snippetCount = astResult.snippets.length;
            sourceType = 'ast';
        } else if (options.useDiffMode && options.diffByFile) {
            const fileDiff = options.diffByFile.get(normalizedPath) ?? options.diffByFile.get(file.path);
            if (fileDiff?.hunks?.length) {
                snippetCount = fileDiff.hunks.length;
                sourceType = 'diff';
            }
        }
        unitCounter++;
        units.push({
            unitId: `${file.path}#unit#${unitCounter}`,
            path: file.path,
            content: file.content,
            snippetCount: Math.max(1, snippetCount),
            sourceType,
        });
    }
    return units;
}

/** 按文件数切批时的默认批次大小（供主文件与 batching 模式选择使用） */
export { DEFAULT_BATCH_SIZE };
