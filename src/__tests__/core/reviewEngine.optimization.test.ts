/**
 * ReviewEngine 优化相关单元测试
 *
 * 覆盖功能：
 * 1. 早期跳出：blocking 错误时跳过 AI 审查
 * 2. 去重：规则引擎与 AI 审查重复问题合并
 * 3. 并发处理：规则引擎与 AI 审查并发触发
 *
 * 说明：
 * - 为了聚焦优化逻辑，这里使用 mock 的 RuleEngine 和 AIReviewer
 * - FileScanner 仅用 shouldExclude，直接 mock 为 false
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

describe('ReviewEngine 优化逻辑', () => {
    beforeEach(() => {
        ruleEngineCheckFilesMock.mockReset();
        aiReviewerReviewMock.mockReset();
        workingDiffMock.mockReset();
        pendingDiffMock.mockReset();
        readFileMock.mockReset();
        readFileMock.mockResolvedValue('');
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
            message: '文件名包含空格 test file.ts',
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

    it('规则引擎与 AI 审查重复应去重', async () => {
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
            message: '变量 userName 未使用',
            rule: 'no_todo',
            severity: 'error',
        };

        const aiIssue: ReviewIssue = {
            file: 'src/app.ts',
            line: 10,
            column: 1,
            message: '变量 userName 未使用',
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

    it('规则阶段应先于 AI 阶段执行', async () => {
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

        // 规则阶段未完成前，AI 不应开始执行
        await Promise.resolve();
        await Promise.resolve();

        expect(aiReviewerReviewMock).not.toHaveBeenCalled();

        resolveRule([]);
        await reviewPromise;
        expect(aiReviewerReviewMock).toHaveBeenCalledTimes(1);
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

    it('结果只包含变更行上的问题', async () => {
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

        const filtered = (reviewEngine as unknown as {
            filterIncrementalIssues: (items: ReviewIssue[], diff?: Map<string, FileDiff>) => ReviewIssue[];
        }).filterIncrementalIssues(issues, diffByFile);

        expect(filtered.length).toBe(1);
        expect(filtered[0].line).toBe(5);
        expect(filtered[0].message).toBe('增量行问题');
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

    it('保存触发路径中，commentOnly 文件应被 AI 过滤', async () => {
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
                ignore_comment_only_diff: true,
            },
        });

        ruleEngineCheckFilesMock.mockResolvedValue([]);
        aiReviewerReviewMock.mockResolvedValue([]);
        const filePath = path.normalize('src/comment-only.ts');
        workingDiffMock.mockResolvedValue(new Map<string, FileDiff>([
            [
                filePath,
                {
                    path: filePath,
                    hunks: [
                        {
                            newStart: 1,
                            newCount: 1,
                            lines: ['// comment'],
                        },
                    ],
                    formatOnly: false,
                    commentOnly: true,
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

    it('混合输入时 AST 切片应仅覆盖 AI 输入文件', async () => {
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
                ignore_comment_only_diff: true,
            },
            ast: {
                enabled: true,
                max_node_lines: 200,
                max_file_lines: 2000,
            },
        });

        ruleEngineCheckFilesMock.mockResolvedValue([]);
        aiReviewerReviewMock.mockResolvedValue([]);
        const commentOnlyFilePath = path.normalize('src/comment-only.ts');
        const semanticFilePath = path.normalize('src/semantic.ts');
        readFileMock.mockImplementation(async (filePath: string) => {
            if (path.normalize(filePath) === semanticFilePath) {
                return [
                    'export function run() {',
                    '  const x = 1;',
                    '  return x;',
                    '}',
                ].join('\n');
            }
            return '/* comment */';
        });
        workingDiffMock.mockResolvedValue(new Map<string, FileDiff>([
            [
                commentOnlyFilePath,
                {
                    path: commentOnlyFilePath,
                    hunks: [
                        {
                            newStart: 1,
                            newCount: 1,
                            lines: ['// note'],
                        },
                    ],
                    formatOnly: false,
                    commentOnly: true,
                },
            ],
            [
                semanticFilePath,
                {
                    path: semanticFilePath,
                    hunks: [
                        {
                            newStart: 2,
                            newCount: 1,
                            lines: ['  const x = 1;'],
                        },
                    ],
                    formatOnly: false,
                    commentOnly: false,
                },
            ],
        ]));

        const reviewEngine = new ReviewEngine(configManager);
        vi.spyOn(reviewEngine as unknown as {
            collectDiagnosticsByFile: () => Map<string, Array<{ line: number; message: string }>>;
        }, 'collectDiagnosticsByFile').mockReturnValue(new Map());
        await reviewEngine.initialize();

        await reviewEngine.reviewFilesWithWorkingDiff([commentOnlyFilePath, semanticFilePath]);

        expect(aiReviewerReviewMock).toHaveBeenCalledTimes(1);
        const request = aiReviewerReviewMock.mock.calls[0][0] as {
            files: Array<{ path: string }>;
        };
        expect(request.files.map(item => path.normalize(item.path))).toEqual([semanticFilePath]);
        const readTargets = readFileMock.mock.calls.map(args => path.normalize(args[0]));
        expect(readTargets).toContain(semanticFilePath);
        expect(readTargets).not.toContain(commentOnlyFilePath);
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

        expect(pendingDiffMock).toHaveBeenCalledWith(undefined, [filePath]);
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

    it('保存复审 scope hints 时，应构造切片 diff 与 AST override', async () => {
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

    it('保存复审无有效 scope hints 时，应回退整文件', async () => {
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

    it('切片复审返回空结果时，应回退整文件', async () => {
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

    describe('AST 切片多文件并发（optimize-ast-slice）', () => {
        const fileA = path.normalize('src/a.ts');
        const fileB = path.normalize('src/b.ts');
        const contentA = ['const a = 1;', 'function fa() { return a; }'].join('\n');
        const contentB = ['const b = 2;', 'function fb() { return b; }'].join('\n');

        const makeDiff = (pathKey: string, newStart: number, lines: string[]): FileDiff => ({
            path: pathKey,
            hunks: [{ newStart, newCount: lines.length, lines }],
            formatOnly: false,
            commentOnly: false,
        });

        it('多文件并发且结果正确：返回 Map 中每路径对应该文件的 AffectedScopeResult', async () => {
            const configManager = createMockConfigManager({
                rules: { enabled: false, strict_mode: false, diff_only: true },
                ai_review: {
                    enabled: true,
                    api_format: 'openai',
                    api_endpoint: 'https://api.example.com',
                    timeout: 1000,
                    action: 'warning',
                    diff_only: true,
                },
                ast: {
                    enabled: true,
                    max_node_lines: 200,
                    max_file_lines: 2000,
                    slice_concurrency: 4,
                },
            });
            readFileMock.mockImplementation(async (filePath: string) => {
                if (path.normalize(filePath) === fileA) return contentA;
                if (path.normalize(filePath) === fileB) return contentB;
                return '';
            });
            const diffByFile = new Map<string, FileDiff>([
                [fileA, makeDiff(fileA, 2, ['function fa() { return a; }'])],
                [fileB, makeDiff(fileB, 2, ['function fb() { return b; }'])],
            ]);
            ruleEngineCheckFilesMock.mockResolvedValue([]);
            aiReviewerReviewMock.mockResolvedValue([]);

            const reviewEngine = new ReviewEngine(configManager);
            vi.spyOn(reviewEngine as unknown as { collectDiagnosticsByFile: () => Map<string, Array<{ line: number; message: string }>> }, 'collectDiagnosticsByFile').mockReturnValue(new Map());
            await reviewEngine.initialize();

            await reviewEngine.review([fileA, fileB], { diffByFile });

            expect(aiReviewerReviewMock).toHaveBeenCalledTimes(1);
            const request = aiReviewerReviewMock.mock.calls[0][0] as { astSnippetsByFile?: Map<string, { snippets: Array<{ startLine: number; endLine: number; source: string }> }> };
            expect(request.astSnippetsByFile).toBeDefined();
            expect(request.astSnippetsByFile!.size).toBe(2);
            expect(request.astSnippetsByFile!.get(fileA)).toBeDefined();
            expect(request.astSnippetsByFile!.get(fileB)).toBeDefined();
            expect(request.astSnippetsByFile!.get(fileA)!.snippets.length).toBeGreaterThan(0);
            expect(request.astSnippetsByFile!.get(fileB)!.snippets.length).toBeGreaterThan(0);
        });

        it('并发数为 1 时顺序执行：结果与多文件一致', async () => {
            const configManager = createMockConfigManager({
                rules: { enabled: false, strict_mode: false, diff_only: true },
                ai_review: {
                    enabled: true,
                    api_format: 'openai',
                    api_endpoint: 'https://api.example.com',
                    timeout: 1000,
                    action: 'warning',
                    diff_only: true,
                },
                ast: {
                    enabled: true,
                    max_node_lines: 200,
                    max_file_lines: 2000,
                    slice_concurrency: 1,
                },
            });
            readFileMock.mockImplementation(async (filePath: string) => {
                if (path.normalize(filePath) === fileA) return contentA;
                if (path.normalize(filePath) === fileB) return contentB;
                return '';
            });
            const diffByFile = new Map<string, FileDiff>([
                [fileA, makeDiff(fileA, 2, ['function fa() { return a; }'])],
                [fileB, makeDiff(fileB, 2, ['function fb() { return b; }'])],
            ]);
            ruleEngineCheckFilesMock.mockResolvedValue([]);
            aiReviewerReviewMock.mockResolvedValue([]);

            const reviewEngine = new ReviewEngine(configManager);
            vi.spyOn(reviewEngine as unknown as { collectDiagnosticsByFile: () => Map<string, Array<{ line: number; message: string }>> }, 'collectDiagnosticsByFile').mockReturnValue(new Map());
            await reviewEngine.initialize();

            await reviewEngine.review([fileA, fileB], { diffByFile });

            expect(aiReviewerReviewMock).toHaveBeenCalledTimes(1);
            const request = aiReviewerReviewMock.mock.calls[0][0] as { astSnippetsByFile?: Map<string, { snippets: Array<{ startLine: number; endLine: number; source: string }> }> };
            expect(request.astSnippetsByFile!.size).toBe(2);
            expect(request.astSnippetsByFile!.get(fileA)!.snippets.length).toBeGreaterThan(0);
            expect(request.astSnippetsByFile!.get(fileB)!.snippets.length).toBeGreaterThan(0);
        });
    });
});
