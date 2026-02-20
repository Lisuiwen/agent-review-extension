import type { ReviewIssue } from '../types/review';

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
        threshold = 0.65
    ): ReviewIssue[] {
        if (issues.length <= 1) {
            return issues;
        }

        const aiIndicesByLine = new Map<string, number[]>();
        issues.forEach((issue, index) => {
            if (!this.isAiIssue(issue)) {
                return;
            }
            const key = this.getLineScopeKey(issue);
            const current = aiIndicesByLine.get(key) ?? [];
            current.push(index);
            aiIndicesByLine.set(key, current);
        });

        const selectedAiIndices = new Set<number>();

        for (const indices of aiIndicesByLine.values()) {
            const representatives: Array<{ index: number; issue: ReviewIssue }> = [];

            for (const index of indices) {
                const candidateIssue = issues[index];
                const existingRep = representatives.find((rep) =>
                    this.calculateMessageSimilarity(rep.issue.message, candidateIssue.message) >= threshold
                );

                if (!existingRep) {
                    representatives.push({ index, issue: candidateIssue });
                    continue;
                }

                const candidatePriority = this.severityPriority[candidateIssue.severity];
                const existingPriority = this.severityPriority[existingRep.issue.severity];
                if (candidatePriority > existingPriority) {
                    existingRep.index = index;
                    existingRep.issue = candidateIssue;
                }
            }

            for (const rep of representatives) {
                selectedAiIndices.add(rep.index);
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

    private static getLineScopeKey(issue: ReviewIssue): string {
        const normalizedPath = issue.file.replace(/\\/g, '/');
        return `${normalizedPath}:${issue.line}`;
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
        if (leftTokens.size === 0 || rightTokens.size === 0) {
            return 0;
        }

        const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
        return intersection / Math.max(leftTokens.size, rightTokens.size);
    }

    private static normalizeMessageForSimilarity(message: string): string {
        return message
            .toLowerCase()
            .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
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
