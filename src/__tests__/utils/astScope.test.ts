/**
 * astScope 单元测试
 *
 * 覆盖 getAffectedScope：.ts/.tsx 的 Babel 片段；.vue 的 SFC 按 block 解析（script/scriptSetup/template）。
 */

import { describe, it, expect } from 'vitest';
import { getAffectedScope } from '../../utils/astScope';
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
    });
});
