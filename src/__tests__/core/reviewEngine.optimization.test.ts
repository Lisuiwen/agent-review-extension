/**
 * ReviewEngine 浼樺寲鐩稿叧鍗曞厓娴嬭瘯
 *
 * 瑕嗙洊鍔熻兘锛? * 1. 鏃╂湡閫€鍑猴細blocking 閿欒鏃惰烦杩?AI 瀹℃煡
 * 2. 鍘婚噸锛氳鍒欏紩鎿庝笌 AI 瀹℃煡閲嶅闂鍚堝苟
 * 3. 骞惰澶勭悊锛氳鍒欏紩鎿庝笌 AI 瀹℃煡骞惰瑙﹀彂
 *
 * 璇存槑锛? * - 涓轰簡鑱氱劍浼樺寲閫昏緫锛岃繖閲屼娇鐢?mock 鐨?RuleEngine 涓?AIReviewer
 * - FileScanner 浠呯敤浜?shouldExclude锛岀洿鎺?mock 涓?false
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';
import { createMockConfigManager } from '../helpers/mockConfigManager';
import { ReviewEngine, ReviewIssue } from '../../core/reviewEngine';
import type { FileDiff } from '../../utils/diffTypes';

const ruleEngineCheckFilesMock = vi.fn<() => Promise<ReviewIssue[]>>(async () => []);
const aiReviewerReviewMock = vi.fn<(...args: unknown[]) => Promise<ReviewIssue[]>>(async () => []);
const workingDiffMock = vi.fn<() => Promise<Map<string, FileDiff>>>(async () => new Map());
const pendingDiffMock = vi.fn<() => Promise<Map<string, FileDiff>>>(async () => new Map());
const readFileMock = vi.fn<(filePath: string) => Promise<string>>(async (filePath: string) => {
    void filePath;
    return '';
});

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
        getPendingDiff = pendingDiffMock;
        readFile = readFileMock;
    },
}));

describe('ReviewEngine 浼樺寲閫昏緫', () => {
    beforeEach(() => {
        ruleEngineCheckFilesMock.mockReset();
        aiReviewerReviewMock.mockReset();
        workingDiffMock.mockReset();
        pendingDiffMock.mockReset();
        readFileMock.mockReset();
        readFileMock.mockResolvedValue('');
    });

    it('瑙勫垯寮曟搸鍙戠幇 blocking 閿欒鏃跺簲璺宠繃 AI 瀹℃煡', async () => {
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
            message: '鏂囦欢鍚嶅寘鍚┖鏍? test file.ts',
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

    it('鏃?blocking 閿欒鏃跺簲鎵ц AI 瀹℃煡', async () => {
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
            message: '鍙戠幇 TODO 娉ㄩ噴',
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

    it('瑙勫垯寮曟搸涓?AI 瀹℃煡閲嶅闂搴斿幓閲?', async () => {
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
            message: '鍙橀噺 userName 鏈畾涔?',
            rule: 'no_todo',
            severity: 'error',
        };

        const aiIssue: ReviewIssue = {
            file: 'src/app.ts',
            line: 10,
            column: 1,
            message: '鍙橀噺 userName 鏈畾涔?',
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

    it('瑙勫垯寮曟搸涓?AI 瀹℃煡搴斿苟琛岃Е鍙?', async () => {
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

        // 绛夊緟 runAiReview 鍐呴儴鎵ц鍒?aiReviewer.review锛堝杞井浠诲姟锛?
        await Promise.resolve();
        await Promise.resolve();

        expect(aiReviewerReviewMock).toHaveBeenCalledTimes(1);

        resolveRule([]);
        await reviewPromise;
    });

    it('AI 瀹℃煡璋冪敤搴旀惡甯?diagnosticsByFile锛岀敤浜庡幓閲嶇櫧鍚嶅崟', async () => {
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

    it('搴斿熀浜?diff 琛屽彿姝ｇ‘鏍囪 incremental', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        const issues: ReviewIssue[] = [
            {
                file: 'src/demo.ts',
                line: 5,
                column: 1,
                message: '澧為噺琛岄棶棰?',
                rule: 'ai_review',
                severity: 'warning',
            },
            {
                file: 'src/demo.ts',
                line: 20,
                column: 1,
                message: '瀛橀噺琛岄棶棰?',
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

    it('淇濆瓨瑙﹀彂璺緞涓紝formatOnly 鏂囦欢搴旇 AI 杩囨护', async () => {
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
    it('手动 run 应使用 pending diff 作为默认审查范围', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        const filePath = path.normalize('src/pending.ts');
        pendingDiffMock.mockResolvedValue(new Map<string, FileDiff>([
            [
                filePath,
                {
                    path: filePath,
                    hunks: [
                        {
                            newStart: 3,
                            newCount: 1,
                            lines: ['const x = 1;'],
                        },
                    ],
                    formatOnly: false,
                },
            ],
        ]));
        const reviewSpy = vi.spyOn(reviewEngine, 'review').mockResolvedValue({
            passed: true,
            errors: [],
            warnings: [],
            info: [],
        });

        await reviewEngine.reviewPendingChanges();

        expect(pendingDiffMock).toHaveBeenCalledTimes(1);
        expect(reviewSpy).toHaveBeenCalledTimes(1);
        const [files, options] = reviewSpy.mock.calls[0] as [string[], { diffByFile?: Map<string, FileDiff> }];
        expect(files).toEqual([filePath]);
        expect(options.diffByFile?.get(filePath)?.hunks.length).toBe(1);
    });

    it('reviewPendingChangesWithContext 在无 pending 变更时应返回 no_pending_changes', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        pendingDiffMock.mockResolvedValue(new Map());
        const reviewSpy = vi.spyOn(reviewEngine, 'review');

        const context = await reviewEngine.reviewPendingChangesWithContext();

        expect(context.reason).toBe('no_pending_changes');
        expect(context.pendingFiles).toEqual([]);
        expect(context.result.errors.length).toBe(0);
        expect(context.result.warnings.length).toBe(0);
        expect(context.result.info.length).toBe(0);
        expect(reviewSpy).not.toHaveBeenCalled();
    });

    it('reviewPendingChangesWithContext 在有 pending 变更时应返回 reviewed', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        const filePath = path.normalize('src/reviewed.ts');
        pendingDiffMock.mockResolvedValue(new Map<string, FileDiff>([
            [
                filePath,
                {
                    path: filePath,
                    hunks: [
                        {
                            newStart: 1,
                            newCount: 1,
                            lines: ['const reviewed = true;'],
                        },
                    ],
                    formatOnly: false,
                },
            ],
        ]));
        const reviewSpy = vi.spyOn(reviewEngine, 'review').mockResolvedValue({
            passed: false,
            errors: [
                {
                    file: filePath,
                    line: 1,
                    column: 1,
                    message: 'mock issue',
                    rule: 'ai_review',
                    severity: 'error',
                },
            ],
            warnings: [],
            info: [],
        });

        const context = await reviewEngine.reviewPendingChangesWithContext();

        expect(context.reason).toBe('reviewed');
        expect(context.pendingFiles).toEqual([filePath]);
        expect(context.result.errors.length).toBe(1);
        expect(reviewSpy).toHaveBeenCalledTimes(1);
    });

    it('保存复审应优先使用 pending diff，并返回 diff 覆盖范围上下文', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        const filePath = path.normalize('src/save.ts');
        pendingDiffMock.mockResolvedValue(new Map<string, FileDiff>([
            [
                filePath,
                {
                    path: filePath,
                    hunks: [
                        {
                            newStart: 10,
                            newCount: 2,
                            lines: ['const a = 1;', 'const b = 2;'],
                        },
                        {
                            newStart: 20,
                            newCount: 1,
                            lines: ['const c = 3;'],
                        },
                    ],
                    formatOnly: false,
                },
            ],
        ]));
        const reviewSpy = vi.spyOn(reviewEngine, 'review').mockResolvedValue({
            passed: true,
            errors: [],
            warnings: [],
            info: [],
        });

        const context = await reviewEngine.reviewSavedFileWithPendingDiffContext(filePath);

        expect(pendingDiffMock).toHaveBeenCalledWith([filePath]);
        expect(reviewSpy).toHaveBeenCalledTimes(1);
        const options = reviewSpy.mock.calls[0][1] as {
            diffByFile?: Map<string, FileDiff>;
        };
        expect(options.diffByFile?.get(filePath)?.hunks[0].newStart).toBe(10);
        expect(context.mode).toBe('diff');
        expect(context.reason).toBe('reviewed');
        expect(context.reviewedRanges).toEqual([
            { startLine: 10, endLine: 11 },
            { startLine: 20, endLine: 20 },
        ]);
        expect(context.result.passed).toBe(true);
    });

    it('保存复审在 pending diff 不可用时应回退整文件并返回 full 上下文', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        const filePath = path.normalize('src/save-fallback.ts');
        pendingDiffMock.mockResolvedValue(new Map());
        const reviewSpy = vi.spyOn(reviewEngine, 'review').mockResolvedValue({
            passed: true,
            errors: [],
            warnings: [],
            info: [],
        });

        const context = await reviewEngine.reviewSavedFileWithPendingDiffContext(filePath);

        expect(reviewSpy).toHaveBeenCalledTimes(1);
        expect(reviewSpy).toHaveBeenCalledWith([filePath], expect.any(Object));
        const options = reviewSpy.mock.calls[0][1] as {
            diffByFile?: Map<string, FileDiff>;
        };
        expect(options.diffByFile).toBeUndefined();
        expect(context.mode).toBe('full');
        expect(context.reason).toBe('no_target_diff');
        expect(context.reviewedRanges).toEqual([]);
    });

    it('reviewSavedFileWithPendingDiff 应保持兼容并返回 context.result', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        const filePath = path.normalize('src/save-compat.ts');
        pendingDiffMock.mockResolvedValue(new Map<string, FileDiff>([
            [
                filePath,
                {
                    path: filePath,
                    hunks: [
                        {
                            newStart: 1,
                            newCount: 1,
                            lines: ['const compat = true;'],
                        },
                    ],
                    formatOnly: false,
                },
            ],
        ]));
        const expectedResult = {
            passed: false,
            errors: [
                {
                    file: filePath,
                    line: 1,
                    column: 1,
                    message: 'compat issue',
                    rule: 'ai_review',
                    severity: 'error' as const,
                },
            ],
            warnings: [],
            info: [],
        };
        vi.spyOn(reviewEngine, 'review').mockResolvedValue(expectedResult);

        const result = await reviewEngine.reviewSavedFileWithPendingDiff(filePath);

        expect(result).toEqual(expectedResult);
    });

    it('淇濆瓨澶嶅鏈?scope hints 鏃讹紝搴旀瀯閫犲垏鐗?diff 涓?AST override', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        const filePath = path.normalize('src/scope.ts');
        readFileMock.mockResolvedValue([
            'const a = 1;',
            'function run() {',
            '  console.log(a);',
            '}',
        ].join('\n'));
        const reviewSpy = vi.spyOn(reviewEngine, 'review').mockResolvedValue({
            passed: false,
            errors: [],
            warnings: [
                {
                    file: filePath,
                    line: 2,
                    column: 1,
                    message: 'scope warning',
                    rule: 'ai_review',
                    severity: 'warning',
                },
            ],
            info: [],
        });

        const result = await reviewEngine.reviewSavedFileWithScopeHints(filePath, [
            { startLine: 2, endLine: 3, source: 'ast' },
        ]);

        expect(result.passed).toBe(false);
        expect(result.warnings.length).toBe(1);
        expect(reviewSpy).toHaveBeenCalledTimes(1);
        const options = reviewSpy.mock.calls[0][1] as {
            diffByFile?: Map<string, FileDiff>;
            astSnippetsByFileOverride?: Map<string, { snippets: Array<{ startLine: number; endLine: number; source: string }> }>;
        };
        expect(options.diffByFile?.get(filePath)?.hunks.length).toBe(1);
        expect(options.diffByFile?.get(filePath)?.hunks[0].newStart).toBe(2);
        expect(options.astSnippetsByFileOverride?.get(filePath)?.snippets.length).toBe(1);
        expect(options.astSnippetsByFileOverride?.get(filePath)?.snippets[0].startLine).toBe(2);
    });

    it('淇濆瓨澶嶅鏃犳湁鏁?scope hints 鏃讹紝搴斿洖閫€鏁存枃浠跺瀹?', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        const filePath = path.normalize('src/fallback.ts');
        const reviewSpy = vi.spyOn(reviewEngine, 'review').mockResolvedValue({
            passed: true,
            errors: [],
            warnings: [],
            info: [],
        });

        await reviewEngine.reviewSavedFileWithScopeHints(filePath, []);

        expect(reviewSpy).toHaveBeenCalledTimes(1);
        expect(reviewSpy).toHaveBeenCalledWith([filePath], expect.any(Object));
        const options = reviewSpy.mock.calls[0][1] as {
            diffByFile?: Map<string, FileDiff>;
            astSnippetsByFileOverride?: Map<string, unknown>;
        };
        expect(options.diffByFile).toBeUndefined();
        expect(options.astSnippetsByFileOverride).toBeUndefined();
    });

    it('鍒囩墖澶嶅杩斿洖绌虹粨鏋滄椂锛屽簲鑷姩鍥為€€鏁存枃浠跺瀹?', async () => {
        const configManager = createMockConfigManager();
        const reviewEngine = new ReviewEngine(configManager);
        const filePath = path.normalize('src/empty-scope.ts');
        readFileMock.mockResolvedValue([
            'const a = 1;',
            'const b = a + 1;',
        ].join('\n'));
        const reviewSpy = vi.spyOn(reviewEngine, 'review')
            .mockResolvedValueOnce({
                passed: true,
                errors: [],
                warnings: [],
                info: [],
            })
            .mockResolvedValueOnce({
                passed: false,
                errors: [],
                warnings: [
                    {
                        file: filePath,
                        line: 2,
                        column: 1,
                        message: 'full fallback warning',
                        rule: 'ai_review',
                        severity: 'warning',
                    },
                ],
                info: [],
            });

        const result = await reviewEngine.reviewSavedFileWithScopeHints(filePath, [
            { startLine: 2, endLine: 2, source: 'ast' },
        ]);

        expect(reviewSpy).toHaveBeenCalledTimes(2);
        const firstOptions = reviewSpy.mock.calls[0][1] as {
            diffByFile?: Map<string, FileDiff>;
            astSnippetsByFileOverride?: Map<string, unknown>;
        };
        const secondOptions = reviewSpy.mock.calls[1][1] as {
            diffByFile?: Map<string, FileDiff>;
            astSnippetsByFileOverride?: Map<string, unknown>;
        };
        expect(firstOptions.diffByFile).toBeDefined();
        expect(firstOptions.astSnippetsByFileOverride).toBeDefined();
        expect(secondOptions.diffByFile).toBeUndefined();
        expect(secondOptions.astSnippetsByFileOverride).toBeUndefined();
        expect(result.warnings.length).toBe(1);
    });
});

