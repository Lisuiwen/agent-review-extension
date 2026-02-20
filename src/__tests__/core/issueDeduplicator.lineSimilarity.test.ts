import { describe, expect, it } from 'vitest';
import { IssueDeduplicator } from '../../core/issueDeduplicator';
import type { ReviewIssue } from '../../types/review';

const createIssue = (overrides: Partial<ReviewIssue>): ReviewIssue => ({
    file: 'src/demo.ts',
    line: 10,
    column: 1,
    message: 'default message',
    rule: 'ai_review',
    severity: 'warning',
    ...overrides,
});

describe('IssueDeduplicator.dedupeAiIssuesByLineSimilarity', () => {
    it('同文件同行且消息高相似时应合并', () => {
        const issues: ReviewIssue[] = [
            createIssue({
                message: 'Unused variable userName found in function',
            }),
            createIssue({
                message: 'Unused variable userName in this function body',
            }),
        ];

        const deduplicated = IssueDeduplicator.dedupeAiIssuesByLineSimilarity(issues);

        expect(deduplicated).toHaveLength(1);
    });

    it('同文件同行但消息低相似时不应合并', () => {
        const issues: ReviewIssue[] = [
            createIssue({
                message: 'Unused variable userName found in function',
            }),
            createIssue({
                message: 'Potential SQL injection risk detected',
            }),
        ];

        const deduplicated = IssueDeduplicator.dedupeAiIssuesByLineSimilarity(issues);

        expect(deduplicated).toHaveLength(2);
    });

    it('重复候选中应保留更高严重级', () => {
        const issues: ReviewIssue[] = [
            createIssue({
                message: 'missing null check before access',
                severity: 'warning',
            }),
            createIssue({
                message: 'missing null check before property access',
                severity: 'error',
            }),
        ];

        const deduplicated = IssueDeduplicator.dedupeAiIssuesByLineSimilarity(issues);

        expect(deduplicated).toHaveLength(1);
        expect(deduplicated[0].severity).toBe('error');
    });

    it('非 AI 问题不应参与去重', () => {
        const issues: ReviewIssue[] = [
            createIssue({
                message: 'foo',
                rule: 'no_todo',
            }),
            createIssue({
                message: 'foo',
                rule: 'no_todo',
            }),
        ];

        const deduplicated = IssueDeduplicator.dedupeAiIssuesByLineSimilarity(issues);

        expect(deduplicated).toHaveLength(2);
    });
});
