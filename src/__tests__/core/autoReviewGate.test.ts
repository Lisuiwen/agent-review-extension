import { describe, expect, it } from 'vitest';
import {
    evaluateAutoReviewGate,
    DEFAULT_RUN_ON_SAVE_RISK_PATTERNS,
    getEffectiveChangedLines,
} from '../../core/autoReviewGate';
import type { FileDiff } from '../../types/diff';

const buildDiff = (overrides?: Partial<FileDiff>): FileDiff => ({
    path: 'src/demo.ts',
    hunks: [
        {
            newStart: 1,
            newCount: 1,
            lines: ['const a = 1;'],
        },
    ],
    addedLines: 1,
    deletedLines: 0,
    addedContentLines: ['const a = 1;'],
    ...overrides,
});

const baseConfig = {
    skipSameContent: true,
    minEffectiveChangedLines: 3,
    riskPatterns: DEFAULT_RUN_ON_SAVE_RISK_PATTERNS,
    funnelLintSeverity: 'error' as const,
};

describe('autoReviewGate', () => {
    it('相同内容哈希应跳过 same_content', () => {
        const decision = evaluateAutoReviewGate({
            trigger: 'save',
            savedContentHash: 'abc',
            lastReviewedContentHash: 'abc',
            diff: buildDiff(),
            diagnostics: [],
            config: baseConfig,
        });

        expect(decision.skip).toBe(true);
        expect(decision.reason).toBe('same_content');
    });

    it('无 pending diff 时应跳过 no_pending_diff', () => {
        const decision = evaluateAutoReviewGate({
            trigger: 'save',
            savedContentHash: 'abc',
            lastReviewedContentHash: 'def',
            diff: null,
            diagnostics: [],
            config: baseConfig,
        });

        expect(decision.skip).toBe(true);
        expect(decision.reason).toBe('no_pending_diff');
    });

    it('formatOnly 变更应跳过 noise_only_change', () => {
        const decision = evaluateAutoReviewGate({
            trigger: 'save',
            savedContentHash: 'abc',
            lastReviewedContentHash: 'def',
            diff: buildDiff({
                formatOnly: true,
                addedLines: 10,
                deletedLines: 10,
            }),
            diagnostics: [],
            config: baseConfig,
        });

        expect(decision.skip).toBe(true);
        expect(decision.reason).toBe('noise_only_change');
    });

    it('commentOnly 变更应跳过 noise_only_change', () => {
        const decision = evaluateAutoReviewGate({
            trigger: 'save',
            savedContentHash: 'abc',
            lastReviewedContentHash: 'def',
            diff: buildDiff({
                commentOnly: true,
                addedLines: 12,
                deletedLines: 6,
            }),
            diagnostics: [],
            config: baseConfig,
        });

        expect(decision.skip).toBe(true);
        expect(decision.reason).toBe('noise_only_change');
    });

    it('命中 error 级 diagnostics 漏斗时应跳过 diagnostic_funnel', () => {
        const decision = evaluateAutoReviewGate({
            trigger: 'save',
            savedContentHash: 'abc',
            lastReviewedContentHash: 'def',
            diff: buildDiff({ addedLines: 10 }),
            diagnostics: [{ severity: 'error' }],
            config: baseConfig,
        });

        expect(decision.skip).toBe(true);
        expect(decision.reason).toBe('diagnostic_funnel');
    });

    it('小改动且未命中风险特征时应跳过 small_low_risk_change', () => {
        const decision = evaluateAutoReviewGate({
            trigger: 'save',
            savedContentHash: 'abc',
            lastReviewedContentHash: 'def',
            diff: buildDiff({
                addedLines: 1,
                deletedLines: 1,
                addedContentLines: ['const msg = "hello";'],
            }),
            diagnostics: [],
            config: baseConfig,
        });

        expect(decision.skip).toBe(true);
        expect(decision.reason).toBe('small_low_risk_change');
    });

    it('小改动但命中风险特征时不应跳过', () => {
        const decision = evaluateAutoReviewGate({
            trigger: 'save',
            savedContentHash: 'abc',
            lastReviewedContentHash: 'def',
            diff: buildDiff({
                addedLines: 1,
                deletedLines: 0,
                addedContentLines: ['if (danger) { eval(code); }'],
            }),
            diagnostics: [],
            config: baseConfig,
        });

        expect(decision.skip).toBe(false);
        expect(decision.riskMatched).toBe(true);
    });

    it('手动触发不应应用自动保存门控', () => {
        const decision = evaluateAutoReviewGate({
            trigger: 'manual',
            savedContentHash: 'abc',
            lastReviewedContentHash: 'abc',
            diff: buildDiff(),
            diagnostics: [{ severity: 'error' }],
            config: baseConfig,
        });

        expect(decision.skip).toBe(false);
    });

    it('应优先使用 added/deleted 统计计算有效改动行数', () => {
        const effective = getEffectiveChangedLines(
            buildDiff({
                addedLines: 2,
                deletedLines: 5,
                hunks: [{ newStart: 1, newCount: 20, lines: [] }],
            })
        );
        expect(effective).toBe(7);
    });
});
