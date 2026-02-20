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

    it('中文同义改写在同文件同行时应合并', () => {
        const issues: ReviewIssue[] = [
            createIssue({
                message: 'v-for 缺少 :key，会导致 Vue 列表渲染问题',
                file: 'src/sample.vue',
                line: 22,
            }),
            createIssue({
                message: 'v-for 指令缺少 :key 属性，会导致列表渲染问题',
                file: 'src/sample.vue',
                line: 22,
            }),
        ];

        const deduplicated = IssueDeduplicator.dedupeAiIssuesByLineSimilarity(issues);

        expect(deduplicated).toHaveLength(1);
    });

    it('中文内容不同且低相似时不应误合并', () => {
        const issues: ReviewIssue[] = [
            createIssue({
                message: '建议将字符串模板改为模板字面量',
                file: 'src/sample.vue',
                line: 30,
            }),
            createIssue({
                message: '此处缺少异常捕获，可能导致页面白屏',
                file: 'src/sample.vue',
                line: 30,
            }),
        ];

        const deduplicated = IssueDeduplicator.dedupeAiIssuesByLineSimilarity(issues);

        expect(deduplicated).toHaveLength(2);
    });
});

describe('IssueDeduplicator.dedupeAiIssuesByProximityAndSimilarity', () => {
    it('同文件邻近行(±2)且高相似时应合并', () => {
        const issues: ReviewIssue[] = [
            createIssue({
                file: 'src/nearby.ts',
                line: 20,
                message: 'rawName 可能为 null，建议判空后再访问',
            }),
            createIssue({
                file: 'src/nearby.ts',
                line: 22,
                message: 'rawName 可能是 null，先做空值判断再使用',
            }),
        ];

        const deduplicated = IssueDeduplicator.dedupeAiIssuesByProximityAndSimilarity(issues, {
            lineWindow: 2,
            similarityThreshold: 0.42,
            sameSeverityPick: 'latest',
        });

        expect(deduplicated).toHaveLength(1);
        expect(deduplicated[0].line).toBe(22);
    });

    it('同文件跨行超过窗口(>2)时不应合并', () => {
        const issues: ReviewIssue[] = [
            createIssue({
                file: 'src/far.ts',
                line: 10,
                message: 'v-for 缺少 :key 属性，可能导致渲染异常',
            }),
            createIssue({
                file: 'src/far.ts',
                line: 14,
                message: 'v-for 指令缺少 :key，可能引发渲染异常',
            }),
        ];

        const deduplicated = IssueDeduplicator.dedupeAiIssuesByProximityAndSimilarity(issues, {
            lineWindow: 2,
            similarityThreshold: 0.42,
        });

        expect(deduplicated).toHaveLength(2);
    });

    it('同严重级重复候选应保留最新一条', () => {
        const issues: ReviewIssue[] = [
            createIssue({
                file: 'src/latest.ts',
                line: 8,
                severity: 'warning',
                message: 'user 可能为 null，建议增加空值判断',
            }),
            createIssue({
                file: 'src/latest.ts',
                line: 9,
                severity: 'warning',
                message: 'user 可能是 null，建议先做判空避免运行时异常',
            }),
        ];

        const deduplicated = IssueDeduplicator.dedupeAiIssuesByProximityAndSimilarity(issues, {
            lineWindow: 2,
            similarityThreshold: 0.42,
            sameSeverityPick: 'latest',
        });

        expect(deduplicated).toHaveLength(1);
        expect(deduplicated[0].line).toBe(9);
    });
});
