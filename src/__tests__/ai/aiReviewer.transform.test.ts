import { describe, expect, it } from 'vitest';
import {
    actionToSeverity,
    mapSeverity,
    normalizeLineEndings,
    resolveIssuePositionFromSnippet,
    transformToReviewIssues,
} from '../../ai/aiReviewer.transform';

describe('aiReviewer.transform', () => {
    it('actionToSeverity/mapSeverity 应正确映射边界', () => {
        expect(actionToSeverity('block_commit')).toBe('error');
        expect(actionToSeverity('warning')).toBe('warning');
        expect(actionToSeverity('log')).toBe('info');

        expect(mapSeverity('info', 'block_commit')).toBe('warning');
        expect(mapSeverity('error', 'warning')).toBe('warning');
        expect(mapSeverity('warning', 'log')).toBe('info');
    });

    it('normalizeLineEndings 应统一 CRLF 为 LF', () => {
        expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');
    });

    it('resolveIssuePositionFromSnippet 应在 CRLF + trim + fallback 下定位正确', () => {
        const content = 'line1\r\n  const x = 1;\r\nline3';
        const byTrim = resolveIssuePositionFromSnippet(content, 'const x = 1;', 10, 20);
        expect(byTrim).toEqual({ line: 2, column: 3 });

        const fallback = resolveIssuePositionFromSnippet(content, 'not-exists', 7, 9);
        expect(fallback).toEqual({ line: 7, column: 9 });
    });

    it('transformToReviewIssues 应支持 snippet 定位与 useDiffLineNumbers', () => {
        const config = { action: 'warning' } as any;
        const response = {
            issues: [
                {
                    file: 'a.ts',
                    line: 10,
                    column: 8,
                    snippet: 'const y = 2;',
                    message: 'm1',
                    severity: 'error',
                },
                {
                    file: 'a.ts',
                    line: 3,
                    column: 1,
                    message: 'm2',
                    severity: 'info',
                },
            ],
        } as any;
        const files = [{ path: 'a.ts', content: 'const x = 1;\nconst y = 2;\nconst z = 3;' }];

        const bySnippet = transformToReviewIssues(config, response, files);
        expect(bySnippet[0].line).toBe(2);
        expect(bySnippet[0].column).toBe(1);
        expect(bySnippet[0].severity).toBe('warning'); // warning action 将 error 降为 warning

        const byDiff = transformToReviewIssues(config, response, files, { useDiffLineNumbers: true });
        expect(byDiff[0].line).toBe(10);
        expect(byDiff[0].column).toBe(8);
    });
});
