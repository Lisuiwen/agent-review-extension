import { describe, expect, it, vi } from 'vitest';
import {
    cleanJsonContent,
    extractJsonFromText,
    extractPartialJson,
    fixJsonEscapeChars,
    isContentTruncated,
    isTruncatedJsonError,
    parseCustomResponse,
} from '../../ai/aiReviewer.responseParser';

const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
} as any;

describe('aiReviewer.responseParser', () => {
    it('cleanJsonContent 应从 markdown 代码块提取 JSON', () => {
        const content = '```json\n{"issues":[]}\n```';
        expect(cleanJsonContent(content, logger)).toBe('{"issues":[]}');
    });

    it('isContentTruncated 应识别完整与截断 JSON', () => {
        expect(isContentTruncated('{"issues":[]}')).toBe(false);
        expect(isContentTruncated('{"issues":[')).toBe(true);
    });

    it('isTruncatedJsonError 应识别常见截断错误模式', () => {
        expect(isTruncatedJsonError('Unexpected end of JSON input', '{"issues":[')).toBe(true);
        expect(isTruncatedJsonError('random parse error', '{"issues":[{"a":1},')).toBe(true);
    });

    it('extractPartialJson 应从截断内容提取可用 issue', () => {
        const truncated =
            '{"issues":[{"file":"a.ts","line":1,"column":1,"message":"m1","severity":"warning"},' +
            '{"file":"b.ts","line":2,"column":1,"message":"m2","severity":"error"},';
        const parsed = extractPartialJson(truncated, logger) as { issues: Array<{ file: string }> };
        expect(parsed.issues).toHaveLength(2);
        expect(parsed.issues[0].file).toBe('a.ts');
        expect(parsed.issues[1].file).toBe('b.ts');
    });

    it('extractPartialJson 在没有可提取 issue 时应抛错', () => {
        expect(() => extractPartialJson('{"foo":1}', logger)).toThrow();
    });

    it('fixJsonEscapeChars + extractJsonFromText 应修复 Windows 路径转义', () => {
        const text = 'prefix {"issues":[{"file":"C:\\work\\a.ts","line":1,"column":1,"message":"ok","severity":"info"}]} suffix';
        const parsed = extractJsonFromText(text, logger) as { issues: Array<{ file: string }> };
        expect(parsed).not.toBeNull();
        expect(parsed.issues[0].file).toBe('C:\\work\\a.ts');
        expect(fixJsonEscapeChars('{"p":"C:\\work\\x.ts"}')).toContain('C:\\\\work\\\\x.ts');
    });

    it('parseCustomResponse 应校验 custom payload 并在非法时抛错', () => {
        const ok = parseCustomResponse(
            { issues: [{ file: 'a.ts', line: 1, column: 1, message: 'm', severity: 'warning' }] },
            logger
        );
        expect(ok.issues).toHaveLength(1);

        expect(() => parseCustomResponse({ issues: [{ file: '', message: 'x', severity: 'warning' }] }, logger)).toThrow(
            /自定义API响应格式验证失败/
        );
    });
});
