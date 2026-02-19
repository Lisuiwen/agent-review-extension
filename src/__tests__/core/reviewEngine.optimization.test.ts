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
import * as path from 'path';
import { createMockConfigManager } from '../helpers/mockConfigManager';
import { ReviewEngine, ReviewIssue } from '../../core/reviewEngine';
import type { FileDiff } from '../../utils/diffTypes';

const ruleEngineCheckFilesMock = vi.fn<() => Promise<ReviewIssue[]>>(async () => []);
const aiReviewerReviewMock = vi.fn<(...args: unknown[]) => Promise<ReviewIssue[]>>(async () => []);
const workingDiffMock = vi.fn<() => Promise<Map<string, FileDiff>>>(async () => new Map());

vi.mock('../../core/ruleEngine', () => ({
    RuleEngine: class {
        initialize = vi.fn();
        checkFiles = ruleEngineCheckFilesMock;
    },
}));

vi.mock('../../ai/aiReviewer', () => ({
    AIReviewer: class {
        initialize = vi.fn();
        review = aiReviewerReviewMock;
    },
}));

vi.mock('../../utils/fileScanner', () => ({
    FileScanner: class {
        shouldExclude = vi.fn().mockReturnValue(false);
        getWorkingDiff = workingDiffMock;
    },
}));

describe('ReviewEngine 优化逻辑', () => {
    beforeEach(() => {
        ruleEngineCheckFilesMock.mockReset();
        aiReviewerReviewMock.mockReset();
        workingDiffMock.mockReset();
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
        vi.spyOn(reviewEngine as unknown as {
            collectDiagnosticsByFile: () => Map<string, Array<{ line: number; message: string }>>;
        }, 'collectDiagnosticsByFile').mockReturnValue(new Map());
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
        vi.spyOn(reviewEngine as unknown as {
            collectDiagnosticsByFile: () => Map<string, Array<{ line: number; message: string }>>;
        }, 'collectDiagnosticsByFile').mockReturnValue(new Map());
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

        // 等待 runAiReview 内部执行到 aiReviewer.review（多轮微任务）
        await Promise.resolve();
        await Promise.resolve();

        expect(aiReviewerReviewMock).toHaveBeenCalledTimes(1);

        resolveRule([]);
        await reviewPromise;
    });

    it('AI 审查调用应携带 diagnosticsByFile，用于去重白名单', async () => {
        const configManager = createMockConfigManager({
            rules: {
                enabled: false,
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
        ruleEngineCheckFilesMock.mockResolvedValue([]);
        aiReviewerReviewMock.mockResolvedValue([]);
        const reviewEngine = new ReviewEngine(configManager);
        const diagnosticsMap = new Map<string, Array<{ line: number; message: string }>>([
            ['src/demo.ts', [{ line: 2, message: 'x is assigned a value but never used' }]],
        ]);
        vi.spyOn(reviewEngine as unknown as {
            collectDiagnosticsByFile: () => Map<string, Array<{ line: number; message: string }>>;
        }, 'collectDiagnosticsByFile').mockReturnValue(diagnosticsMap);
        await reviewEngine.initialize();

        await reviewEngine.review(['src/demo.ts']);

        expect(aiReviewerReviewMock).toHaveBeenCalledTimes(1);
        const request = aiReviewerReviewMock.mock.calls[0][0] as {
            diagnosticsByFile?: Map<string, Array<{ line: number; message: string }>>;
        };
        const diagnostics = request.diagnosticsByFile?.get('src/demo.ts') ?? [];
        expect(diagnostics.length).toBe(1);
        expect(diagnostics[0].line).toBe(2);
    });

    it('应基于 diff 行号正确标记 incremental', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        const issues: ReviewIssue[] = [
            {
                file: 'src/demo.ts',
                line: 5,
                column: 1,
                message: '增量行问题',
                rule: 'ai_review',
                severity: 'warning',
            },
            {
                file: 'src/demo.ts',
                line: 20,
                column: 1,
                message: '存量行问题',
                rule: 'ai_review',
                severity: 'warning',
            },
        ];
        const diffByFile = new Map<string, FileDiff>([
            ['src/demo.ts', {
                path: 'src/demo.ts',
                hunks: [
                    {
                        newStart: 5,
                        newCount: 3,
                        lines: ['const a = 1;', 'const b = 2;', 'console.log(a + b);'],
                    },
                ],
            }],
        ]);

        (reviewEngine as unknown as {
            markIncrementalIssues: (items: ReviewIssue[], diff?: Map<string, FileDiff>) => void;
        }).markIncrementalIssues(issues, diffByFile);

        expect(issues[0].incremental).toBe(true);
        expect(issues[1].incremental).toBe(false);
    });

    it('保存触发路径中，formatOnly 文件应被 AI 过滤', async () => {
        const configManager = createMockConfigManager({
            rules: {
                enabled: false,
                strict_mode: false,
                diff_only: true,
            },
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                timeout: 1000,
                action: 'warning',
                diff_only: true,
                ignore_format_only_diff: true,
            },
        });

        ruleEngineCheckFilesMock.mockResolvedValue([]);
        aiReviewerReviewMock.mockResolvedValue([]);
        const filePath = path.normalize('src/sample.vue');
        workingDiffMock.mockResolvedValue(new Map<string, FileDiff>([
            [
                filePath,
                {
                    path: filePath,
                    hunks: [
                        {
                            newStart: 1,
                            newCount: 1,
                            lines: ['<template>'],
                        },
                    ],
                    formatOnly: true,
                },
            ],
        ]));

        const reviewEngine = new ReviewEngine(configManager);
        vi.spyOn(reviewEngine as unknown as {
            collectDiagnosticsByFile: () => Map<string, Array<{ line: number; message: string }>>;
        }, 'collectDiagnosticsByFile').mockReturnValue(new Map());
        await reviewEngine.initialize();

        await reviewEngine.reviewFilesWithWorkingDiff([filePath]);

        expect(workingDiffMock).toHaveBeenCalledTimes(1);
        expect(aiReviewerReviewMock).not.toHaveBeenCalled();
    });
});
