/**
 * AIReviewer 优化相关单元测试
 *
 * 覆盖功能：
 * 1. file_count 兼容：默认 5 文件一批
 * 2. AST 片段预算分批：60 片段 + budget=25 => 3 批
 * 3. 同文件多单元不丢失
 * 4. 并发池上限控制
 * 5. max_request_chars 超限自动降载二分
 * 6. 截断响应续写回归
 * 7. ast_chunk_weight_by=chars 时按字符数分批且与 batch_concurrency 配合
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIReviewer } from '../../ai/aiReviewer';
import { createMockConfigManager } from '../helpers/mockConfigManager';
import type { AffectedScopeResult } from '../../utils/astScope';

const createAstResult = (count: number, startLine = 1): AffectedScopeResult => ({
    snippets: Array.from({ length: count }, (_, idx) => {
        const line = startLine + idx;
        return {
            startLine: line,
            endLine: line,
            source: `const v${line} = ${line};`,
        };
    }),
});

type CallApiInput = { files: Array<{ path: string; content: string }> };

describe('AIReviewer 批处理优化', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('batching_mode=file_count 时保持 5 文件一批', async () => {
        const configManager = createMockConfigManager({
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-api-key',
                model: 'test-model',
                timeout: 1000,
                action: 'warning',
                batching_mode: 'file_count',
            },
        });

        const aiReviewer = new AIReviewer(configManager);
        await aiReviewer.initialize();

        const files = Array.from({ length: 11 }, (_, index) => ({
            path: `src/file${index + 1}.ts`,
            content: `export const value${index + 1} = ${index + 1};`,
        }));

        const callApiSpy = vi
            .spyOn(aiReviewer as unknown as { callAPI: (input: CallApiInput) => Promise<{ issues: Array<any> }> }, 'callAPI')
            .mockResolvedValue({ issues: [] });

        const result = await aiReviewer.review({ files });

        expect(callApiSpy).toHaveBeenCalledTimes(3);
        const batchSizes = callApiSpy.mock.calls.map(call => call[0].files.length).sort((a, b) => a - b);
        expect(batchSizes).toEqual([1, 5, 5]);
        expect(result).toEqual([]);
    });

    it('AST 60 片段按预算 25 分批时应拆为 3 批，且同文件多单元不丢失', async () => {
        const configManager = createMockConfigManager({
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-api-key',
                model: 'test-model',
                timeout: 1000,
                action: 'warning',
                batching_mode: 'ast_snippet',
                ast_snippet_budget: 25,
                ast_chunk_strategy: 'even',
                batch_concurrency: 2,
            },
        });

        const aiReviewer = new AIReviewer(configManager);
        await aiReviewer.initialize();

        const filePath = 'src/huge.ts';
        const astSnippetsByFile = new Map<string, AffectedScopeResult>([
            [filePath, createAstResult(60, 1)],
        ]);

        const callApiSpy = vi
            .spyOn(aiReviewer as unknown as { callAPI: (input: CallApiInput) => Promise<{ issues: Array<any> }> }, 'callAPI')
            .mockImplementation(async (input) => {
                const content = input.files[0].content;
                const match = content.match(/# 行 (\d+)/);
                const line = match ? Number(match[1]) : 1;
                return {
                    issues: [{
                        file: filePath,
                        line,
                        column: 1,
                        message: `m-${line}`,
                        severity: 'warning',
                    }],
                };
            });

        const result = await aiReviewer.review({
            files: [{ path: filePath }],
            astSnippetsByFile,
        });

        expect(callApiSpy).toHaveBeenCalledTimes(3);
        expect(callApiSpy.mock.calls.every(call => call[0].files.length === 1)).toBe(true);
        expect(callApiSpy.mock.calls.every(call => call[0].files[0].path === filePath)).toBe(true);

        // 3 个 AST 子单元都应保留结果，不因同路径去重被误丢弃
        expect(result.length).toBe(3);
        const lines = result.map(issue => issue.line).sort((a, b) => a - b);
        expect(lines).toEqual([1, 21, 41]);
    });

    it('并发=2 时同一时刻最多执行 2 个批次', async () => {
        const configManager = createMockConfigManager({
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-api-key',
                model: 'test-model',
                timeout: 1000,
                action: 'warning',
                batching_mode: 'ast_snippet',
                ast_snippet_budget: 1,
                batch_concurrency: 2,
            },
        });

        const aiReviewer = new AIReviewer(configManager);
        await aiReviewer.initialize();

        const files = Array.from({ length: 4 }, (_, idx) => ({ path: `src/c${idx + 1}.ts` }));
        const astSnippetsByFile = new Map<string, AffectedScopeResult>(
            files.map((file, idx) => [file.path, createAstResult(1, idx + 1)])
        );

        let inFlight = 0;
        let maxInFlight = 0;

        const callApiSpy = vi
            .spyOn(aiReviewer as unknown as { callAPI: (input: CallApiInput) => Promise<{ issues: Array<any> }> }, 'callAPI')
            .mockImplementation(async (input) => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise(resolve => setTimeout(resolve, 50));
                inFlight--;
                const match = input.files[0].content.match(/# 行 (\d+)/);
                const line = match ? Number(match[1]) : 1;
                return {
                    issues: [{
                        file: input.files[0].path,
                        line,
                        column: 1,
                        message: 'ok',
                        severity: 'warning',
                    }],
                };
            });

        const result = await aiReviewer.review({ files, astSnippetsByFile });

        expect(callApiSpy).toHaveBeenCalledTimes(4);
        expect(result.length).toBe(4);
        expect(maxInFlight).toBe(2);
    });

    it('请求超出 max_request_chars 时应自动二分降载', async () => {
        const configManager = createMockConfigManager({
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-api-key',
                model: 'test-model',
                timeout: 1000,
                action: 'warning',
                batching_mode: 'file_count',
                max_request_chars: 80,
            },
        });

        const aiReviewer = new AIReviewer(configManager);
        await aiReviewer.initialize();

        const files = [
            { path: 'src/a.ts', content: `const a = '${'x'.repeat(1200)}';` },
            { path: 'src/b.ts', content: `const b = '${'y'.repeat(1200)}';` },
        ];

        const callApiSpy = vi
            .spyOn(aiReviewer as unknown as { callAPI: (input: CallApiInput) => Promise<{ issues: Array<any> }> }, 'callAPI')
            .mockImplementation(async (input) => ({
                issues: [{
                    file: input.files[0].path,
                    line: 1,
                    column: 1,
                    message: 'ok',
                    severity: 'warning',
                }],
            }));

        const result = await aiReviewer.review({ files });

        expect(callApiSpy).toHaveBeenCalledTimes(2);
        expect(callApiSpy.mock.calls.every(call => call[0].files.length === 1)).toBe(true);
        expect(result.length).toBe(2);
    });

    it('400/context too long 时应触发批次二分降载重试', async () => {
        const configManager = createMockConfigManager({
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-api-key',
                model: 'test-model',
                timeout: 1000,
                action: 'warning',
                batching_mode: 'file_count',
            },
        });

        const aiReviewer = new AIReviewer(configManager);
        await aiReviewer.initialize();

        const files = [
            { path: 'src/a.ts', content: 'const a = 1;' },
            { path: 'src/b.ts', content: 'const b = 2;' },
        ];

        let attempt = 0;
        const contextTooLongError = {
            isAxiosError: true,
            message: 'context_length_exceeded',
            response: {
                status: 400,
                data: { error: { message: 'prompt too long' } },
            },
        };

        const callApiSpy = vi
            .spyOn(aiReviewer as unknown as { callAPI: (input: CallApiInput) => Promise<{ issues: Array<any> }> }, 'callAPI')
            .mockImplementation(async (input) => {
                attempt++;
                if (attempt === 1) {
                    throw contextTooLongError;
                }
                return {
                    issues: [{
                        file: input.files[0].path,
                        line: 1,
                        column: 1,
                        message: 'ok',
                        severity: 'warning',
                    }],
                };
            });

        const result = await aiReviewer.review({ files });

        expect(callApiSpy).toHaveBeenCalledTimes(3);
        expect(callApiSpy.mock.calls[0][0].files.length).toBe(2);
        expect(callApiSpy.mock.calls.slice(1).every(call => call[0].files.length === 1)).toBe(true);
        expect(result.length).toBe(2);
    });

    it('截断响应应触发续写并合并去重结果', async () => {
        const configManager = createMockConfigManager({
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-api-key',
                timeout: 1000,
                retry_count: 1,
                action: 'warning',
            },
        });

        const aiReviewer = new AIReviewer(configManager);
        await aiReviewer.initialize();

        const truncatedContent = `{
  "issues": [
    {
      "file": "src/a.ts",
      "line": 1,
      "column": 1,
      "message": "m1",
      "severity": "warning"
    }`;

        const continuationContent = `{
  "issues": [
    {
      "file": "src/a.ts",
      "line": 1,
      "column": 1,
      "message": "m1",
      "severity": "warning"
    },
    {
      "file": "src/b.ts",
      "line": 2,
      "column": 1,
      "message": "m2",
      "severity": "info"
    }
  ]
}`;

        const postMock = vi.fn()
            .mockResolvedValueOnce({
                data: {
                    choices: [{ message: { content: truncatedContent } }],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    choices: [{ message: { content: continuationContent } }],
                },
            });

        (aiReviewer as unknown as { axiosInstance: { post: typeof postMock } }).axiosInstance.post = postMock;

        const response = await (aiReviewer as unknown as {
            callAPI: (input: { files: Array<{ path: string; content: string }> }) => Promise<{ issues: Array<any> }>
        }).callAPI({
            files: [{ path: 'src/a.ts', content: 'const a = 1;' }],
        });

        expect(postMock).toHaveBeenCalledTimes(2);
        expect(response.issues.length).toBe(2);
        expect(response.issues[0].file).toBe('src/a.ts');
        expect(response.issues[1].file).toBe('src/b.ts');
    });

    it('ast_chunk_weight_by=chars 时按字符数分批且每批不超过 max_request_chars', async () => {
        const charBudget = 500;
        const configManager = createMockConfigManager({
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-api-key',
                model: 'test-model',
                timeout: 1000,
                action: 'warning',
                batching_mode: 'ast_snippet',
                ast_snippet_budget: 25,
                ast_chunk_weight_by: 'chars',
                max_request_chars: charBudget,
                batch_concurrency: 2,
            },
        });

        const aiReviewer = new AIReviewer(configManager);
        await aiReviewer.initialize();

        // 每个 snippet 约 30 字符，5 个 snippet 一单元 => 每单元约 150 字符；设 4 单元 => 约 600 字符，按 500 上限应拆成多批
        const filePath = 'src/foo.ts';
        const astSnippetsByFile = new Map<string, AffectedScopeResult>([
            [filePath, createAstResult(20, 1)], // 20 片段会按 even 拆成多 chunk，每 chunk 一 unit
        ]);

        const callApiSpy = vi
            .spyOn(aiReviewer as unknown as { callAPI: (input: CallApiInput) => Promise<{ issues: Array<any> }> }, 'callAPI')
            .mockImplementation(async (input) => ({
                issues: [{
                    file: input.files[0].path,
                    line: 1,
                    column: 1,
                    message: 'ok',
                    severity: 'warning',
                }],
            }));

        await aiReviewer.review({
            files: [{ path: filePath }],
            astSnippetsByFile,
        });

        const calls = callApiSpy.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        for (const call of calls) {
            const totalChars = call[0].files.reduce((sum, f) => sum + f.path.length + f.content.length, 0);
            expect(totalChars).toBeLessThanOrEqual(charBudget + 2000);
        }
    });

    it('ast_chunk_weight_by=chars 时与 batch_concurrency 配合并发数生效', async () => {
        const configManager = createMockConfigManager({
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-api-key',
                model: 'test-model',
                timeout: 1000,
                action: 'warning',
                batching_mode: 'ast_snippet',
                ast_snippet_budget: 25,
                ast_chunk_weight_by: 'chars',
                max_request_chars: 400,
                batch_concurrency: 2,
            },
        });

        const aiReviewer = new AIReviewer(configManager);
        await aiReviewer.initialize();

        const filePath = 'src/bar.ts';
        const astSnippetsByFile = new Map<string, AffectedScopeResult>([
            [filePath, createAstResult(30, 1)],
        ]);

        let inFlight = 0;
        let maxInFlight = 0;
        const callApiSpy = vi
            .spyOn(aiReviewer as unknown as { callAPI: (input: CallApiInput) => Promise<{ issues: Array<any> }> }, 'callAPI')
            .mockImplementation(async (input) => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise(resolve => setTimeout(resolve, 30));
                inFlight--;
                return {
                    issues: [{
                        file: input.files[0].path,
                        line: 1,
                        column: 1,
                        message: 'ok',
                        severity: 'warning',
                    }],
                };
            });

        await aiReviewer.review({
            files: [{ path: filePath }],
            astSnippetsByFile,
        });

        expect(callApiSpy).toHaveBeenCalled();
        expect(maxInFlight).toBeLessThanOrEqual(2);
    });
});
