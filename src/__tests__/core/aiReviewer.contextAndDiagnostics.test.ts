import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConfigManager } from '../helpers/mockConfigManager';
import type { AffectedScopeResult } from '../../utils/astScope';

const { buildLspReferenceContextMock } = vi.hoisted(() => ({
    buildLspReferenceContextMock: vi.fn<() => Promise<string>>(),
}));

vi.mock('../../utils/lspContext', () => ({
    buildLspReferenceContext: buildLspReferenceContextMock,
}));

import { AIReviewer } from '../../ai/aiReviewer';

describe('AIReviewer 上下文补全与 Diagnostics 去重', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        buildLspReferenceContextMock.mockReset();
    });

    it('AST 模式应在发送内容中区分当前审查代码与外部引用上下文', async () => {
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
            ast: {
                enabled: true,
                include_lsp_context: true,
            },
        });
        const aiReviewer = new AIReviewer(configManager);
        await aiReviewer.initialize();

        const filePath = 'src/context.ts';
        const astSnippetsByFile = new Map<string, AffectedScopeResult>([
            [filePath, {
                snippets: [
                    {
                        startLine: 10,
                        endLine: 11,
                        source: 'const value = helper(input);\nreturn value;',
                    },
                ],
            }],
        ]);

        buildLspReferenceContextMock.mockResolvedValue('符号: helper\n定义: src/utils.ts:2\n代码:\n# 行 2\nexport const helper = () => 1;');

        const callApiSpy = vi
            .spyOn(aiReviewer as unknown as { callAPI: (input: { files: Array<{ path: string; content: string }> }) => Promise<{ issues: Array<any> }> }, 'callAPI')
            .mockResolvedValue({ issues: [] });

        await aiReviewer.review({
            files: [{ path: filePath }],
            astSnippetsByFile,
        });

        expect(buildLspReferenceContextMock).toHaveBeenCalledTimes(1);
        const sentContent = callApiSpy.mock.calls[0][0].files[0].content;
        expect(sentContent).toContain('【当前审查代码】');
        expect(sentContent).toContain('【外部引用上下文（仅供参考）】');
        expect(sentContent).toContain('符号: helper');
    });

    it('应过滤与 diagnostics 同行的 AI 问题', async () => {
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

        const callApiSpy = vi
            .spyOn(aiReviewer as unknown as { callAPI: (input: { files: Array<{ path: string; content: string }> }) => Promise<{ issues: Array<any> }> }, 'callAPI')
            .mockResolvedValue({
                issues: [
                    { file: 'src/a.ts', line: 2, column: 1, message: '与 lint 重复', severity: 'warning' },
                    { file: 'src/a.ts', line: 4, column: 1, message: '真实 AI 问题', severity: 'warning' },
                ],
            });

        const result = await aiReviewer.review({
            files: [{ path: 'src/a.ts', content: 'const a = 1;\nlet x;\nconst b = 2;\nx = b;\n' }],
            diagnosticsByFile: new Map<string, Array<{ line: number; message: string }>>([
                ['src/a.ts', [{ line: 2, message: 'x 已声明但从未读取' }]],
            ]),
        });

        expect(callApiSpy).toHaveBeenCalledTimes(1);
        expect(result.length).toBe(1);
        expect(result[0].line).toBe(4);
        expect(result[0].message).toContain('真实 AI 问题');
    });

    it('构建请求时应带上已知问题白名单提示词', async () => {
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

        const requestBody = (aiReviewer as unknown as {
            buildOpenAIRequest: (
                request: { files: Array<{ path: string; content: string }> },
                isDiffContent?: boolean,
                diagnosticsByFile?: Map<string, Array<{ line: number; message: string }>>
            ) => { messages: Array<{ role: string; content: string }> };
        }).buildOpenAIRequest(
            {
                files: [{ path: 'src/a.ts', content: 'const a = 1;' }],
            },
            false,
            new Map<string, Array<{ line: number; message: string }>>([
                ['src/a.ts', [{ line: 1, message: '缺少分号' }]],
            ])
        );

        const userMessage = requestBody.messages.find(item => item.role === 'user')?.content ?? '';
        expect(userMessage).toContain('已知问题白名单');
        expect(userMessage).toContain('src/a.ts 行 1: 缺少分号');
    });
});
