/**
 * ReviewEngine 优化相关单元测试
 *
 * 覆盖功能：
 * 1. 早期退出：blocking 错误时跳过 AI 审查
 * 2. 去重：规则引擎与 AI 审查重复问题合并
 * 3. 并行处理：规则引擎与 AI 审查并行触发
 *
 * 说明：
 * - 为了聚焦优化逻辑，这里使用 mock 的 RuleEngine 与 AIReviewer
 * - FileScanner 仅用于 shouldExclude，直接 mock 为 false
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConfigManager } from '../helpers/mockConfigManager';
import { ReviewEngine, ReviewIssue } from '../../core/reviewEngine';

const ruleEngineCheckFilesMock = vi.fn<() => Promise<ReviewIssue[]>>(async () => []);
const aiReviewerReviewMock = vi.fn<() => Promise<ReviewIssue[]>>(async () => []);

vi.mock('../../core/ruleEngine', () => ({
    RuleEngine: class {
        initialize = vi.fn();
        checkFiles = ruleEngineCheckFilesMock;
    },
}));

vi.mock('../../core/aiReviewer', () => ({
    AIReviewer: class {
        initialize = vi.fn();
        review = aiReviewerReviewMock;
    },
}));

vi.mock('../../utils/fileScanner', () => ({
    FileScanner: class {
        shouldExclude = vi.fn().mockReturnValue(false);
    },
}));

describe('ReviewEngine 优化逻辑', () => {
    beforeEach(() => {
        ruleEngineCheckFilesMock.mockReset();
        aiReviewerReviewMock.mockReset();
    });

    it('规则引擎发现 blocking 错误时应跳过 AI 审查', async () => {
        const configManager = createMockConfigManager({
            rules: {
                enabled: true,
                strict_mode: false,
                naming_convention: {
                    enabled: true,
                    action: 'block_commit',
                    no_space_in_filename: true,
                },
            },
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                timeout: 1000,
                action: 'warning',
            },
        });

        const blockingIssue: ReviewIssue = {
            file: 'test file.ts',
            line: 1,
            column: 1,
            message: '文件名包含空格: test file.ts',
            rule: 'no_space_in_filename',
            severity: 'error',
        };

        ruleEngineCheckFilesMock.mockImplementation(async () => [blockingIssue]);
        aiReviewerReviewMock.mockImplementation(async () => []);

        const reviewEngine = new ReviewEngine(configManager);
        await reviewEngine.initialize();

        const result = await reviewEngine.review(['test file.ts']);

        expect(result.errors.length).toBe(1);
        expect(aiReviewerReviewMock).not.toHaveBeenCalled();
    });

    it('无 blocking 错误时应执行 AI 审查', async () => {
        const configManager = createMockConfigManager({
            rules: {
                enabled: true,
                strict_mode: false,
                code_quality: {
                    enabled: true,
                    action: 'warning',
                    no_todo: true,
                },
            },
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                timeout: 1000,
                action: 'warning',
            },
        });

        const warningIssue: ReviewIssue = {
            file: 'test.ts',
            line: 2,
            column: 5,
            message: '发现 TODO 注释',
            rule: 'no_todo',
            severity: 'warning',
        };

        ruleEngineCheckFilesMock.mockImplementation(async () => [warningIssue]);
        aiReviewerReviewMock.mockImplementation(async () => []);

        const reviewEngine = new ReviewEngine(configManager);
        await reviewEngine.initialize();

        await reviewEngine.review(['test.ts']);

        expect(aiReviewerReviewMock).toHaveBeenCalledTimes(1);
    });

    it('规则引擎与 AI 审查重复问题应去重', async () => {
        const configManager = createMockConfigManager({
            rules: {
                enabled: true,
                strict_mode: false,
            },
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                timeout: 1000,
                action: 'warning',
            },
        });

        const ruleIssue: ReviewIssue = {
            file: 'src/app.ts',
            line: 10,
            column: 1,
            message: '变量 userName 未定义',
            rule: 'no_todo',
            severity: 'error',
        };

        const aiIssue: ReviewIssue = {
            file: 'src/app.ts',
            line: 10,
            column: 1,
            message: '变量 userName 未定义',
            rule: 'ai_review',
            severity: 'error',
        };

        ruleEngineCheckFilesMock.mockImplementation(async () => [ruleIssue]);
        aiReviewerReviewMock.mockImplementation(async () => [aiIssue]);

        const reviewEngine = new ReviewEngine(configManager);
        await reviewEngine.initialize();

        const result = await reviewEngine.review(['src/app.ts']);

        expect(result.errors.length).toBe(1);
    });

    it('规则引擎与 AI 审查应并行触发', async () => {
        const configManager = createMockConfigManager({
            rules: {
                enabled: true,
                strict_mode: false,
            },
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                timeout: 1000,
                action: 'warning',
                skip_on_blocking_errors: false,
            } as any,
        });

        let resolveRule: (value: ReviewIssue[]) => void = () => {};
        ruleEngineCheckFilesMock.mockImplementation(
            () => new Promise(resolve => {
                resolveRule = resolve;
            })
        );
        aiReviewerReviewMock.mockImplementation(async () => []);

        const reviewEngine = new ReviewEngine(configManager);
        await reviewEngine.initialize();

        const reviewPromise = reviewEngine.review(['src/app.ts']);

        await Promise.resolve();

        expect(aiReviewerReviewMock).toHaveBeenCalledTimes(1);

        resolveRule([]);
        await reviewPromise;
    });
});
