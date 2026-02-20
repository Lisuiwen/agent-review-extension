/**
 * vueSfcBlockAtLine 单元测试
 *
 * 覆盖 getEffectiveLanguageIdForVueAtLine：Vue SFC 按行返回等效 languageId（template → html，script → js/ts，style → css/scss/less），
 * 用于放行注释按块选择格式。
 */

import { describe, it, expect } from 'vitest';
import { getEffectiveLanguageIdForVueAtLine } from '../../utils/vueSfcBlockAtLine';

describe('getEffectiveLanguageIdForVueAtLine', () => {
    it('returns html for line inside template block', () => {
        const content = [
            '<template>',
            '  <div class="x">',
            '    <span>hi</span>',
            '  </div>',
            '</template>',
            '<script>export default {};</script>',
        ].join('\n');
        expect(getEffectiveLanguageIdForVueAtLine(content, 1)).toBe('html');
        expect(getEffectiveLanguageIdForVueAtLine(content, 2)).toBe('html');
        expect(getEffectiveLanguageIdForVueAtLine(content, 3)).toBe('html');
        expect(getEffectiveLanguageIdForVueAtLine(content, 4)).toBe('html');
        expect(getEffectiveLanguageIdForVueAtLine(content, 5)).toBe('html');
    });

    it('returns javascript for line inside script block', () => {
        const content = [
            '<template><div>hi</div></template>',
            '<script>',
            'export default {',
            '  data() { return { items: [] }; }',
            '};',
            '</script>',
        ].join('\n');
        expect(getEffectiveLanguageIdForVueAtLine(content, 3)).toBe('javascript');
        expect(getEffectiveLanguageIdForVueAtLine(content, 4)).toBe('javascript');
        expect(getEffectiveLanguageIdForVueAtLine(content, 5)).toBe('javascript');
    });

    it('returns typescript for line inside script setup with lang="ts"', () => {
        const content = [
            '<template><div>hi</div></template>',
            '<script setup lang="ts">',
            'const count = ref(0);',
            '</script>',
        ].join('\n');
        expect(getEffectiveLanguageIdForVueAtLine(content, 2)).toBe('typescript');
        expect(getEffectiveLanguageIdForVueAtLine(content, 3)).toBe('typescript');
    });

    it('returns css/scss/less for line inside style block', () => {
        const content = [
            '<template><div>hi</div></template>',
            '<script>export default {};</script>',
            '<style>',
            '.foo { color: red; }',
            '</style>',
            '<style lang="scss" scoped>',
            '.bar { & .baz { } }',
            '</style>',
        ].join('\n');
        expect(getEffectiveLanguageIdForVueAtLine(content, 4)).toBe('css');
        expect(getEffectiveLanguageIdForVueAtLine(content, 7)).toBe('scss');
    });

    it('returns null when line is outside any block or parse fails', () => {
        const content = [
            '<template><div>hi</div></template>',
            '',
            '<script>export default {};</script>',
        ].join('\n');
        expect(getEffectiveLanguageIdForVueAtLine(content, 2)).toBe(null);
        expect(getEffectiveLanguageIdForVueAtLine('not vue content', 1)).toBe(null);
    });
});
