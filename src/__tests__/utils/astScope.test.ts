/**
 * astScope 单元测试
 *
 * 覆盖 getAffectedScope / getAffectedScopeWithDiagnostics：.ts/.tsx 的 Babel 片段；.vue 的 SFC 按 block 解析；
 * 大节点截断不回退、相邻片段合并（K≥0）/ 关闭合并（K<0）；超过 maxFileLines / 不支持扩展名时早退。对应 change optimize-ast-slice design「测试与验证」。
 */

import { describe, it, expect } from 'vitest';
import { getAffectedScope, getAffectedScopeWithDiagnostics } from '../../utils/astScope';
import type { FileDiff } from '../../utils/diffTypes';

const makeFileDiff = (newStart: number, newCount: number, lines: string[]): FileDiff => ({
    path: '',
    hunks: [{ newStart, newCount, lines }],
});

describe('getAffectedScope', () => {
    describe('Vue SFC', () => {
        it('returns snippets for script block changes', () => {
            const content = [
                '<template><div>hi</div></template>',
                '<script setup lang="ts">',
                'const a = 1;',
                'const b = 2;',
                'function fn() { return a + b; }',
                '</script>',
            ].join('\n');
            const fileDiff = makeFileDiff(3, 3, ['const a = 1;', 'const b = 2;', 'function fn() { return a + b; }']);
            const result = getAffectedScope('x.vue', content, fileDiff);
            expect(result).not.toBeNull();
            expect(result!.snippets.length).toBeGreaterThan(0);
            for (const s of result!.snippets) {
                expect(s.startLine).toBeGreaterThanOrEqual(1);
                expect(s.endLine).toBeLessThanOrEqual(content.split('\n').length);
                const lines = content.split('\n');
                const slice = lines.slice(s.startLine - 1, s.endLine).join('\n');
                expect(s.source).toBe(slice);
            }
        });

        it('returns null when no hunks', () => {
            const content = '<template><div>x</div></template>\n<script>export default {};</script>';
            const result = getAffectedScope('x.vue', content, { path: '', hunks: [] });
            expect(result).toBeNull();
        });

        it('vue: respects maxNodeLines by dropping oversized snippet', () => {
            const lines: string[] = ['<script setup>'];
            for (let i = 0; i < 300; i++) {
                lines.push(`const line${i} = ${i};`);
            }
            lines.push('</script>');
            const content = lines.join('\n');
            const fileDiff = makeFileDiff(2, 5, lines.slice(1, 6));
            const result = getAffectedScope('x.vue', content, fileDiff, { maxNodeLines: 50 });
            expect(result).not.toBeNull();
            for (const s of result!.snippets) {
                expect(s.endLine - s.startLine + 1).toBeLessThanOrEqual(50);
            }
        });
    });

    describe('TS/TSX', () => {
        it('returns smallest containing node for changed line', () => {
            const content = [
                'const a = 1;',
                'function foo() {',
                '  const b = 2;',
                '  return b;',
                '}',
            ].join('\n');
            const fileDiff = makeFileDiff(3, 1, ['  const b = 2;']);
            const result = getAffectedScope('x.ts', content, fileDiff);
            expect(result).not.toBeNull();
            expect(result!.snippets.some((s) => s.source.includes('const b = 2'))).toBe(true);
        });

        it('returns null for .vue when content is not SFC at all', () => {
            const content = 'not vue content';
            const fileDiff = makeFileDiff(1, 1, ['not vue content']);
            const result = getAffectedScope('x.vue', content, fileDiff);
            expect(result).toBeNull();
        });

        it('单节点超 maxNodeLines 时截断并继续，result 非 null', () => {
            const lines: string[] = [];
            for (let i = 0; i < 80; i++) {
                lines.push(`const line${i} = ${i};`);
            }
            const content = lines.join('\n');
            const fileDiff = makeFileDiff(1, 1, [lines[0]]);
            const result = getAffectedScopeWithDiagnostics('x.ts', content, fileDiff, { maxNodeLines: 50 });
            expect(result.result).not.toBeNull();
            const snippets = result.result!.snippets;
            for (const s of snippets) {
                expect(s.endLine - s.startLine + 1).toBeLessThanOrEqual(50);
            }
            expect(snippets.length).toBeGreaterThan(0);
        });

        it('所有节点均不超限时行为不变', () => {
            const content = [
                'const a = 1;',
                'function foo() {',
                '  return a;',
                '}',
            ].join('\n');
            const fileDiff = makeFileDiff(2, 2, ['function foo() {', '  return a;']);
            const result = getAffectedScope('x.ts', content, fileDiff, { maxNodeLines: 100 });
            expect(result).not.toBeNull();
            expect(result!.snippets.some((s) => s.source.includes('function foo'))).toBe(true);
        });

        it('间隔不超过 K 时合并（K≥0）', () => {
            const content = [
                'const a = 1;',
                'function f() {',
                '  return 1;',
                '}',
                'const d = 4;',
            ].join('\n');
            const fileDiff = makeFileDiff(3, 1, ['  return 1;']);
            const withMerge = getAffectedScopeWithDiagnostics('x.ts', content, fileDiff, { mergeSnippetGapLines: 1 });
            const noMerge = getAffectedScopeWithDiagnostics('x.ts', content, fileDiff, { mergeSnippetGapLines: -1 });
            expect(withMerge.result).not.toBeNull();
            expect(noMerge.result).not.toBeNull();
            expect(withMerge.result!.snippets.length).toBeLessThanOrEqual(noMerge.result!.snippets.length);
        });

        it('合并关闭时保持原样（K<0）', () => {
            const content = 'const a = 1;\nconst b = 2;\nconst c = 3;';
            const fileDiff = makeFileDiff(1, 3, ['const a = 1;', 'const b = 2;', 'const c = 3;']);
            const closed = getAffectedScopeWithDiagnostics('x.ts', content, fileDiff, { mergeSnippetGapLines: -1 });
            const withMerge = getAffectedScopeWithDiagnostics('x.ts', content, fileDiff, { mergeSnippetGapLines: 1 });
            expect(closed.result).not.toBeNull();
            expect(withMerge.result).not.toBeNull();
            expect(closed.result!.snippets.length).toBeGreaterThanOrEqual(withMerge.result!.snippets.length);
        });

        it('超过 maxFileLines 时返回 null 及 fallbackReason maxFileLines', () => {
            const lines = Array.from({ length: 100 }, (_, i) => `const l${i} = ${i};`);
            const content = lines.join('\n');
            const fileDiff = makeFileDiff(1, 1, [lines[0]]);
            const out = getAffectedScopeWithDiagnostics('x.ts', content, fileDiff, { maxFileLines: 50 });
            expect(out.result).toBeNull();
            expect(out.fallbackReason).toBe('maxFileLines');
        });

        it('不支持扩展名时返回 null 及 fallbackReason unsupportedExt', () => {
            const content = 'const a = 1;';
            const fileDiff = makeFileDiff(1, 1, ['const a = 1;']);
            const outTs = getAffectedScopeWithDiagnostics('x.ts', content, fileDiff);
            expect(outTs.result).not.toBeNull();
            const outTxt = getAffectedScopeWithDiagnostics('file.txt', content, fileDiff);
            expect(outTxt.result).toBeNull();
            expect(outTxt.fallbackReason).toBe('unsupportedExt');
        });
    });
});
