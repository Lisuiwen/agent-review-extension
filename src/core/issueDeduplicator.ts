import { ReviewIssue } from './reviewEngine';

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
    /**
     * 去重问题列表
     *
     * @param issues - 原始问题列表
     * @returns 去重后的问题列表
     */
    static deduplicate(issues: ReviewIssue[]): ReviewIssue[] {
        const severityPriority: Record<ReviewIssue['severity'], number> = {
            error: 3,
            warning: 2,
            info: 1
        };

        const seen = new Map<string, ReviewIssue>();

        for (const issue of issues) {
            const key = this.getIssueKey(issue);
            const existing = seen.get(key);

            if (!existing) {
                seen.set(key, issue);
                continue;
            }

            const existingPriority = severityPriority[existing.severity];
            const currentPriority = severityPriority[issue.severity];
            if (currentPriority > existingPriority) {
                seen.set(key, issue);
            }
        }

        return Array.from(seen.values());
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
