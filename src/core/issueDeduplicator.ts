import type { ReviewIssue } from '../types/review';

export type DedupeOptions = {
    lineWindow?: number;
    similarityThreshold?: number;
    sameSeverityPick?: 'latest' | 'earliest';
};

/**
 * 问题去重工具
 *
 * 这个文件负责合并规则引擎和 AI 审查的重复问题，避免同一问题重复展示。
 *
 * 去重思路：
 * 1. 使用文件路径 + 行号 + 列号 + 标准化后的消息作为唯一键
 * 2. 当相同键重复出现时，保留严重程度更高的问题
 *
 * 注意：
 * - 标准化消息会去除变量名与数字，降低“同一问题不同描述”的重复率
 * - 这是一种保守去重策略，不会合并不同位置的问题
 */
export class IssueDeduplicator {
    private static readonly severityPriority: Record<ReviewIssue['severity'], number> = {
        error: 3,
        warning: 2,
        info: 1
    };

    /**
     * 去重问题列表
     *
     * @param issues - 原始问题列表
     * @returns 去重后的问题列表
     */
    static deduplicate(issues: ReviewIssue[]): ReviewIssue[] {
        const seen = new Map<string, ReviewIssue>();

        for (const issue of issues) {
            const key = this.getIssueKey(issue);
            const existing = seen.get(key);

            if (!existing) {
                seen.set(key, issue);
                continue;
            }

            const existingPriority = this.severityPriority[existing.severity];
            const currentPriority = this.severityPriority[issue.severity];
            if (currentPriority > existingPriority) {
                seen.set(key, issue);
            }
        }

        return Array.from(seen.values());
    }

    /**
     * 针对 AI 问题做“同文件同行 + 消息相似”去重。
     * 仅合并高相似项（>= threshold），并保留更高严重级；同级保留先出现项。
     */
    static dedupeAiIssuesByLineSimilarity(
        issues: ReviewIssue[],
        threshold = 0.5
    ): ReviewIssue[] {
        return this.dedupeAiIssuesByProximityAndSimilarity(issues, {
            lineWindow: 0,
            similarityThreshold: threshold,
            sameSeverityPick: 'earliest',
        });
    }

    static dedupeAiIssuesByProximityAndSimilarity(
        issues: ReviewIssue[],
        options: DedupeOptions = {}
    ): ReviewIssue[] {
        if (issues.length <= 1) {
            return issues;
        }
        const lineWindow = Math.max(0, Math.floor(options.lineWindow ?? 2));
        const similarityThreshold = options.similarityThreshold ?? 0.42;
        const sameSeverityPick = options.sameSeverityPick ?? 'latest';

        const aiIndicesByFile = new Map<string, number[]>();
        issues.forEach((issue, index) => {
            if (!this.isAiIssue(issue)) {
                return;
            }
            const key = this.getFileScopeKey(issue);
            const current = aiIndicesByFile.get(key) ?? [];
            current.push(index);
            aiIndicesByFile.set(key, current);
        });
        if (aiIndicesByFile.size === 0) {
            return issues;
        }

        const selectedAiIndices = new Set<number>();

        for (const indices of aiIndicesByFile.values()) {
            if (indices.length === 1) {
                selectedAiIndices.add(indices[0]);
                continue;
            }
            const sorted = [...indices].sort((a, b) => {
                const lineDelta = issues[a].line - issues[b].line;
                return lineDelta !== 0 ? lineDelta : a - b;
            });
            const uf = new UnionFind(sorted.length);

            for (let i = 0; i < sorted.length; i++) {
                for (let j = i + 1; j < sorted.length; j++) {
                    const leftIssue = issues[sorted[i]];
                    const rightIssue = issues[sorted[j]];
                    const lineDelta = Math.abs(leftIssue.line - rightIssue.line);
                    if (lineDelta > lineWindow) {
                        if (issues[sorted[j]].line > leftIssue.line + lineWindow) {
                            break;
                        }
                        continue;
                    }
                    const similarity = this.calculateMessageSimilarity(leftIssue.message, rightIssue.message);
                    const sharedAnchorCount = this.getSharedAnchorCount(leftIssue.message, rightIssue.message);
                    const boostedSimilarity = this.applyAnchorBoost(similarity, sharedAnchorCount);
                    const passSimilarity = boostedSimilarity >= similarityThreshold;
                    const allowCrossLineMerge =
                        lineDelta === 0
                        || similarity >= 0.75
                        || sharedAnchorCount > 0;
                    if (passSimilarity && allowCrossLineMerge) {
                        uf.union(i, j);
                    }
                }
            }

            const clusterToWinner = new Map<number, number>();
            for (let i = 0; i < sorted.length; i++) {
                const root = uf.find(i);
                const candidateOriginalIndex = sorted[i];
                const existingOriginalIndex = clusterToWinner.get(root);
                if (existingOriginalIndex === undefined) {
                    clusterToWinner.set(root, candidateOriginalIndex);
                    continue;
                }
                const preferred = this.pickPreferredIssueIndex(
                    existingOriginalIndex,
                    candidateOriginalIndex,
                    issues,
                    sameSeverityPick
                );
                clusterToWinner.set(root, preferred);
            }

            for (const winner of clusterToWinner.values()) {
                selectedAiIndices.add(winner);
            }
        }

        return issues.filter((issue, index) => !this.isAiIssue(issue) || selectedAiIndices.has(index));
    }

    /**
     * 合并并去重多个问题列表
     *
     * @param issueLists - 多个问题列表
     * @returns 合并且去重后的问题列表
     */
    static mergeAndDeduplicate(...issueLists: ReviewIssue[][]): ReviewIssue[] {
        const merged = issueLists.flat();
        return this.deduplicate(merged);
    }

    /**
     * 生成问题的唯一键
     *
     * @param issue - 审查问题
     * @returns 唯一键字符串
     */
    private static getIssueKey(issue: ReviewIssue): string {
        const normalizedPath = issue.file.replace(/\\/g, '/');
        const normalizedMessage = this.normalizeMessage(issue.message);
        return `${normalizedPath}:${issue.line}:${issue.column}:${normalizedMessage}`;
    }

    private static getFileScopeKey(issue: ReviewIssue): string {
        const normalizedPath = issue.file.replace(/\\/g, '/');
        return normalizedPath;
    }

    private static isAiIssue(issue: ReviewIssue): boolean {
        return issue.rule === 'ai_review' || issue.rule.startsWith('ai_');
    }

    private static calculateMessageSimilarity(left: string, right: string): number {
        const normalizedLeft = this.normalizeMessageForSimilarity(left);
        const normalizedRight = this.normalizeMessageForSimilarity(right);

        if (!normalizedLeft || !normalizedRight) {
            return 0;
        }

        if (
            normalizedLeft === normalizedRight
            || normalizedLeft.includes(normalizedRight)
            || normalizedRight.includes(normalizedLeft)
        ) {
            return 1;
        }

        const leftTokens = new Set(normalizedLeft.split(' ').filter(Boolean));
        const rightTokens = new Set(normalizedRight.split(' ').filter(Boolean));
        const tokenSimilarity = (() => {
            if (leftTokens.size === 0 || rightTokens.size === 0) {
                return 0;
            }
            const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
            return intersection / Math.max(leftTokens.size, rightTokens.size);
        })();

        // 中文改写通常没有空格分词，增加字符 n-gram 回退以提升同义改写召回
        const cjkSimilarity = this.calculateCjkNgramSimilarity(normalizedLeft, normalizedRight, 2);
        return Math.max(tokenSimilarity, cjkSimilarity);
    }

    private static readonly anchorKeywords = [
        'v-for',
        ':key',
        'key',
        'null',
        'undefined',
        'innerhtml',
        'eval',
        'async',
        'await',
        'try',
        'catch',
    ];

    private static getSharedAnchorCount(left: string, right: string): number {
        const normalizedLeft = left.toLowerCase();
        const normalizedRight = right.toLowerCase();
        const leftAnchors = this.anchorKeywords.filter((keyword) => normalizedLeft.includes(keyword));
        if (leftAnchors.length === 0) {
            return 0;
        }
        return leftAnchors.filter((keyword) => normalizedRight.includes(keyword)).length;
    }

    private static applyAnchorBoost(baseSimilarity: number, sharedAnchors: number): number {
        if (sharedAnchors <= 0) {
            return baseSimilarity;
        }
        return Math.min(1, baseSimilarity + 0.06 * sharedAnchors);
    }

    private static pickPreferredIssueIndex(
        leftIndex: number,
        rightIndex: number,
        issues: ReviewIssue[],
        sameSeverityPick: 'latest' | 'earliest'
    ): number {
        const left = issues[leftIndex];
        const right = issues[rightIndex];
        const leftPriority = this.severityPriority[left.severity];
        const rightPriority = this.severityPriority[right.severity];
        if (leftPriority !== rightPriority) {
            return leftPriority > rightPriority ? leftIndex : rightIndex;
        }
        if (sameSeverityPick === 'latest') {
            return leftIndex > rightIndex ? leftIndex : rightIndex;
        }
        return leftIndex < rightIndex ? leftIndex : rightIndex;
    }

    private static normalizeMessageForSimilarity(message: string): string {
        return message
            .toLowerCase()
            .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private static calculateCjkNgramSimilarity(left: string, right: string, n: number): number {
        if (n <= 0) {
            return 0;
        }
        const compactLeft = left.replace(/\s+/g, '');
        const compactRight = right.replace(/\s+/g, '');
        if (!this.hasCjkText(compactLeft) || !this.hasCjkText(compactRight)) {
            return 0;
        }

        const leftNgrams = this.buildNgrams(compactLeft, n);
        const rightNgrams = this.buildNgrams(compactRight, n);
        if (leftNgrams.size === 0 || rightNgrams.size === 0) {
            return 0;
        }

        const intersection = [...leftNgrams].filter((gram) => rightNgrams.has(gram)).length;
        return intersection / Math.max(leftNgrams.size, rightNgrams.size);
    }

    private static buildNgrams(input: string, n: number): Set<string> {
        if (input.length < n) {
            return new Set([input]);
        }
        const grams = new Set<string>();
        for (let i = 0; i <= input.length - n; i++) {
            grams.add(input.slice(i, i + n));
        }
        return grams;
    }

    private static hasCjkText(input: string): boolean {
        return /[\u4e00-\u9fff]/.test(input);
    }

    /**
     * 标准化问题描述
     *
     * @param message - 原始问题描述
     * @returns 标准化后的描述
     */
    private static normalizeMessage(message: string): string {
        return message
            .replace(/'[^']+'/g, '<var>')
            .replace(/"[^"]+"/g, '<var>')
            .replace(/`[^`]+`/g, '<var>')
            .replace(/\d+/g, '<num>')
            .replace(/\s+/g, ' ')
            .trim();
    }
}

class UnionFind {
    private parent: number[];
    private rank: number[];

    constructor(size: number) {
        this.parent = Array.from({ length: size }, (_, i) => i);
        this.rank = Array.from({ length: size }, () => 0);
    }

    find(x: number): number {
        if (this.parent[x] !== x) {
            this.parent[x] = this.find(this.parent[x]);
        }
        return this.parent[x];
    }

    union(a: number, b: number): void {
        const rootA = this.find(a);
        const rootB = this.find(b);
        if (rootA === rootB) {
            return;
        }
        if (this.rank[rootA] < this.rank[rootB]) {
            this.parent[rootA] = rootB;
            return;
        }
        if (this.rank[rootA] > this.rank[rootB]) {
            this.parent[rootB] = rootA;
            return;
        }
        this.parent[rootB] = rootA;
        this.rank[rootA] += 1;
    }
}
