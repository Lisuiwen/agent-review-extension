import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildLspReferenceContext,
    buildLspUsagesContext,
    getReferenceLocations,
} from '../../utils/lspContext';

const mocked = vi.hoisted(() => ({
    executeCommand: vi.fn(),
}));

vi.mock('vscode', () => {
    class Position {
        line: number;
        character: number;
        constructor(line: number, character: number) {
            this.line = line;
            this.character = character;
        }
    }

    class Location {
        uri: { fsPath: string };
        range: { start: { line: number; character?: number }; end: { line: number; character?: number } };
        constructor(
            uri: { fsPath: string },
            range: { start: { line: number; character?: number }; end: { line: number; character?: number } }
        ) {
            this.uri = uri;
            this.range = range;
        }
    }

    return {
        Uri: {
            file: (filePath: string) => ({ fsPath: filePath }),
        },
        Position,
        Location,
        commands: {
            executeCommand: mocked.executeCommand,
        },
    };
});

describe('lspContext', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('buildLspReferenceContext 在 maxDefinitions<=0 或 snippets 为空时返回空串', async () => {
        const empty = await buildLspReferenceContext('/ws/src/a.ts', [], { maxDefinitions: 3 });
        expect(empty).toBe('');

        const noDef = await buildLspReferenceContext(
            '/ws/src/a.ts',
            [{ startLine: 1, endLine: 1, source: 'foo' }],
            { maxDefinitions: 0 }
        );
        expect(noDef).toBe('');
        expect(mocked.executeCommand).not.toHaveBeenCalled();
    });

    it('buildLspReferenceContext 应对 definition 去重并按 maxChars 截断', async () => {
        const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockResolvedValue('l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10');
        mocked.executeCommand.mockResolvedValue([
            {
                uri: { fsPath: '/ws/src/dep.ts' },
                range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } },
            },
        ]);

        const definitions: Array<{ file: string; line: number }> = [];
        const out = await buildLspReferenceContext(
            '/ws/src/a.ts',
            [{ startLine: 1, endLine: 2, source: 'foo()\nfoo()' }],
            { maxDefinitions: 5, maxChars: 60, collectLineRefs: { definitions } }
        );

        expect(definitions).toHaveLength(1);
        expect(definitions[0].file).toMatch(/[\\/]ws[\\/]src[\\/]dep\.ts$/);
        expect(definitions[0].line).toBe(10);
        expect(readFileSpy).toHaveBeenCalledTimes(1);
        expect(out).toContain('...(参考上下文已截断');
    });

    it('buildLspUsagesContext 应遵守 maxUsages/maxChars 并稳定输出结构', async () => {
        vi.spyOn(fs.promises, 'readFile').mockResolvedValue('a1\na2\na3\na4\na5');
        mocked.executeCommand.mockResolvedValue([
            {
                uri: { fsPath: '/ws/src/u.ts' },
                range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
            },
            {
                uri: { fsPath: '/ws/src/u.ts' },
                range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } },
            },
            {
                targetUri: { fsPath: '/ws/src/v.ts' },
                targetRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
            },
        ]);

        const usages: Array<{ file: string; line: number }> = [];
        const out = await buildLspUsagesContext(
            '/ws/src/a.ts',
            [{ startLine: 1, endLine: 1, source: 'foo' }],
            { maxUsages: 1, maxChars: 30, collectLineRefs: { usages } }
        );

        expect(usages).toHaveLength(1);
        expect(usages[0].file).toMatch(/[\\/]ws[\\/]src[\\/]u\.ts$/);
        expect(usages[0].line).toBe(2);
        expect(out).toMatch(/## 调用方\s*\(Usages\)/);
        expect(out).toContain('...(调用方上下文已截断');
    });

    it('getReferenceLocations 应将 LocationLink 转为 Location，异常时返回空数组', async () => {
        mocked.executeCommand.mockResolvedValueOnce([
            {
                targetUri: { fsPath: '/ws/src/ref.ts' },
                targetRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
            },
        ]);

        const refs = await getReferenceLocations({ fsPath: '/ws/src/a.ts' } as any, 2, 3);
        expect(refs).toHaveLength(1);
        expect(refs[0].uri.fsPath).toBe('/ws/src/ref.ts');
        expect(refs[0].range.start.line).toBe(4);

        mocked.executeCommand.mockRejectedValueOnce(new Error('lsp down'));
        const fallback = await getReferenceLocations({ fsPath: '/ws/src/a.ts' } as any, 2, 3);
        expect(fallback).toEqual([]);
    });

    it('buildLspReferenceContext 读取同文件多次应命中缓存，读取失败时返回空串', async () => {
        const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockResolvedValue('x1\nx2\nx3\nx4\nx5');
        mocked.executeCommand.mockImplementation(async (_cmd: string, _uri: unknown, pos: { line: number }) => {
            if (pos.line === 0) {
                return [
                    {
                        uri: { fsPath: '/ws/src/shared.ts' },
                        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
                    },
                ];
            }
            return [
                {
                    uri: { fsPath: '/ws/src/shared.ts' },
                    range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
                },
            ];
        });

        const ok = await buildLspReferenceContext(
            '/ws/src/a.ts',
            [{ startLine: 1, endLine: 2, source: 'foo\nbar' }],
            { maxDefinitions: 5 }
        );
        expect(ok).toMatch(/定义: .*shared\.ts:2/);
        expect(ok).toMatch(/定义: .*shared\.ts:4/);
        expect(readFileSpy).toHaveBeenCalledTimes(1);

        readFileSpy.mockRejectedValueOnce(new Error('read failed'));
        mocked.executeCommand.mockResolvedValue([
            {
                uri: { fsPath: '/ws/src/missing.ts' },
                range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
            },
        ]);
        const failed = await buildLspReferenceContext(
            '/ws/src/a.ts',
            [{ startLine: 1, endLine: 1, source: 'foo' }],
            { maxDefinitions: 1 }
        );
        expect(failed).toBe('');
    });
});
