/**
 * vueSfcRelatedBlocks 单元测试
 *
 * 覆盖 getVueSfcRelatedBlocksForContext：主审在 script 时返回 template、主审在 template 时返回 script，
 * 超过 maxLines 截断、非 SFC 或解析失败返回空。不送 style。
 */

import { describe, it, expect } from 'vitest';
import { getVueSfcRelatedBlocksForContext } from '../../utils/vueSfcRelatedBlocks';

describe('getVueSfcRelatedBlocksForContext', () => {
    it('returns template when main review is in script block', () => {
        const content = [
            '<template>',
            '  <p v-if="user">{{ user.name }}</p>',
            '</template>',
            '<script>',
            'export default {',
            '  data() { return { user: null }; }',
            '};',
            '</script>',
        ].join('\n');
        const result = getVueSfcRelatedBlocksForContext(content, {
            snippetLines: [5, 6],
            maxLines: 60,
        });
        expect(result.script).toBeUndefined();
        expect(result.template).toBeDefined();
        expect(result.template).toContain('同一 SFC 的 template（供参考）');
        expect(result.template).toContain('v-if="user"');
        expect(result.template).toMatch(/# 行 \d+/);
    });

    it('returns script when main review is in template block', () => {
        const content = [
            '<template>',
            '  <p v-if="user">{{ user.name }}</p>',
            '</template>',
            '<script>',
            'export default { data() { return { user: null }; } };',
            '</script>',
        ].join('\n');
        const result = getVueSfcRelatedBlocksForContext(content, {
            snippetLines: [1, 2, 3],
            maxLines: 60,
        });
        expect(result.template).toBeUndefined();
        expect(result.script).toBeDefined();
        expect(result.script).toContain('同一 SFC 的 script（供参考）');
        expect(result.script).toContain('user: null');
    });

    it('truncates block when over maxLines', () => {
        const templateLines = ['<template>', ...Array.from({ length: 80 }, (_, i) => `  line${i}`), '</template>'];
        const content = [...templateLines, '<script>', 'export default {};', '</script>'].join('\n');
        const result = getVueSfcRelatedBlocksForContext(content, {
            snippetLines: [templateLines.length + 2],
            maxLines: 10,
        });
        expect(result.template).toBeDefined();
        expect(result.template).toContain('前 10 行，已截断');
    });

    it('returns empty object for non-SFC or parse failure', () => {
        expect(getVueSfcRelatedBlocksForContext('not vue content', { snippetLines: [1], maxLines: 60 })).toEqual({});
        expect(getVueSfcRelatedBlocksForContext('', { snippetLines: [1], maxLines: 60 })).toEqual({});
    });

    it('returns empty when snippetLines empty or maxLines <= 0', () => {
        const content = '<template><div/></template><script>export default {};</script>';
        expect(getVueSfcRelatedBlocksForContext(content, { snippetLines: [], maxLines: 60 })).toEqual({});
        expect(getVueSfcRelatedBlocksForContext(content, { snippetLines: [2], maxLines: 0 })).toEqual({});
    });

    it('prefers scriptSetup when main is template and both script and scriptSetup exist', () => {
        const content = [
            '<template><div/></template>',
            '<script>export default {};</script>',
            '<script setup lang="ts">const x = 1;</script>',
        ].join('\n');
        const result = getVueSfcRelatedBlocksForContext(content, {
            snippetLines: [1],
            maxLines: 60,
        });
        expect(result.script).toBeDefined();
        expect(result.script).toContain('script');
        expect(result.script).toContain('const x = 1');
    });
});
