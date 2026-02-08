/**
 * AIReviewer 优化相关单元测试
 *
 * 覆盖功能：
 * 1. 批处理：文件数量超过批次上限时分批调用 API
 * 2. 批处理结果合并：多个批次的结果正确合并返回
 *
 * 说明：
 * - 使用 spy 拦截内部方法，避免真实文件读取与网络请求
 * - 只验证批处理调用次数与批次大小
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIReviewer } from '../../core/aiReviewer';
import { createMockConfigManager } from '../helpers/mockConfigManager';

describe('AIReviewer 批处理', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('超过批次大小时应分批调用 API', async () => {
        const configManager = createMockConfigManager({
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-api-key',
                model: 'test-model',
                timeout: 1000,
                action: 'warning',
            },
        });

        const aiReviewer = new AIReviewer(configManager);
        await aiReviewer.initialize();

        const files = Array.from({ length: 11 }, (_, index) => ({
            path: `src/file${index + 1}.ts`,
            content: `export const value${index + 1} = ${index + 1};`,
        }));

        const loadFilesSpy = vi
            .spyOn(aiReviewer as unknown as { loadFilesWithContent: (input: Array<{ path: string }>) => Promise<typeof files> }, 'loadFilesWithContent')
            .mockResolvedValue(files);

        const callApiSpy = vi
            .spyOn(aiReviewer as unknown as { callAPI: (input: { files: typeof files }) => Promise<{ issues: Array<any> }> }, 'callAPI')
            .mockResolvedValue({ issues: [] });

        const result = await aiReviewer.review({
            files: files.map(file => ({ path: file.path })),
        });

        expect(loadFilesSpy).toHaveBeenCalledTimes(1);
        expect(callApiSpy).toHaveBeenCalledTimes(3);
        expect(callApiSpy.mock.calls[0][0].files.length).toBe(5);
        expect(callApiSpy.mock.calls[1][0].files.length).toBe(5);
        expect(callApiSpy.mock.calls[2][0].files.length).toBe(1);
        expect(result.length).toBe(0);
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
                    choices: [{ message: { content: truncatedContent } }]
                }
            })
            .mockResolvedValueOnce({
                data: {
                    choices: [{ message: { content: continuationContent } }]
                }
            });

        (aiReviewer as unknown as { axiosInstance: { post: typeof postMock } }).axiosInstance.post = postMock;

        const response = await (aiReviewer as unknown as {
            callAPI: (input: { files: Array<{ path: string; content: string }> }) => Promise<{ issues: Array<any> }>
        }).callAPI({
            files: [{ path: 'src/a.ts', content: 'const a = 1;' }]
        });

        expect(postMock).toHaveBeenCalledTimes(2);
        expect(response.issues.length).toBe(2);
        expect(response.issues[0].file).toBe('src/a.ts');
        expect(response.issues[1].file).toBe('src/b.ts');
    });

});
