import { describe, expect, it, vi } from 'vitest';
import { loadFilesWithContent } from '../../ai/aiReviewer.contentLoader';

describe('aiReviewer.contentLoader', () => {
    it('已有 content 时应直接使用，不读取文件', async () => {
        const readFile = vi.fn();
        const logger = { warn: vi.fn() } as any;
        const result = await loadFilesWithContent(
            [{ path: 'a.ts', content: 'const a = 1;' }],
            { readFile },
            logger
        );

        expect(result).toEqual([{ path: 'a.ts', content: 'const a = 1;' }]);
        expect(readFile).not.toHaveBeenCalled();
    });

    it('previewOnly=true 时空文件不应 warn', async () => {
        const readFile = vi.fn(async () => '');
        const logger = { warn: vi.fn() } as any;
        const result = await loadFilesWithContent(
            [{ path: 'b.ts' }],
            { readFile },
            logger,
            true
        );

        expect(result).toEqual([{ path: 'b.ts', content: '' }]);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('读取失败时应跳过该文件并告警', async () => {
        const readFile = vi.fn(async (p: string) => {
            if (p === 'bad.ts') throw new Error('read failed');
            return 'ok';
        });
        const logger = { warn: vi.fn() } as any;
        const result = await loadFilesWithContent(
            [{ path: 'ok.ts' }, { path: 'bad.ts' }],
            { readFile },
            logger
        );

        expect(result).toEqual([{ path: 'ok.ts', content: 'ok' }]);
        expect(logger.warn).toHaveBeenCalled();
    });
});
