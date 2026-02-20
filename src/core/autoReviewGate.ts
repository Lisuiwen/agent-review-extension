import type { FileDiff } from '../types/diff';

export type AutoReviewSkipReason =
    | 'same_content'
    | 'small_low_risk_change'
    | 'diagnostic_funnel'
    | 'no_pending_diff'
    | 'noise_only_change';

export type AutoReviewFunnelSeverity = 'off' | 'error' | 'warning';

export type AutoReviewDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export type AutoReviewGateConfig = {
    skipSameContent: boolean;
    minEffectiveChangedLines: number;
    riskPatterns: string[];
    funnelLintSeverity: AutoReviewFunnelSeverity;
};

export type AutoReviewGateInput = {
    trigger: 'save' | 'idle' | 'manual';
    savedContentHash?: string | null;
    lastReviewedContentHash?: string | null;
    diff?: FileDiff | null;
    diagnostics: Array<{ severity: AutoReviewDiagnosticSeverity }>;
    config: AutoReviewGateConfig;
};

export type AutoReviewGateDecision = {
    skip: boolean;
    reason?: AutoReviewSkipReason;
    effectiveChangedLines: number;
    riskMatched: boolean;
};

export const DEFAULT_RUN_ON_SAVE_RISK_PATTERNS = [
    '\\bif\\b',
    '\\belse\\b',
    '\\bswitch\\b',
    '\\bcase\\b',
    '\\bfor\\b',
    '\\bwhile\\b',
    '\\btry\\b',
    '\\bcatch\\b',
    '\\bthrow\\b',
    '\\basync\\b',
    '\\bawait\\b',
    '\\bfunction\\b',
    '=>',
    '\\beval\\s*\\(',
    '\\binnerHTML\\b',
];

const toPositiveInteger = (value: number): number => {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return Math.floor(value);
};

/** 将风险特征字符串编译为正则数组，非法项静默忽略 */
const compileRiskPatterns = (patterns: string[]): RegExp[] =>
    patterns
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .flatMap(p => {
            try {
                return [new RegExp(p, 'i')];
            } catch {
                return [];
            }
        });

const deriveEffectiveChangedLinesFromHunks = (diff: FileDiff): number => {
    return diff.hunks.reduce((sum, hunk) => sum + Math.max(0, hunk.newCount), 0);
};

export const getEffectiveChangedLines = (diff: FileDiff | null | undefined): number => {
    if (!diff || diff.hunks.length === 0) {
        return 0;
    }
    const addedLines = toPositiveInteger(diff.addedLines ?? 0);
    const deletedLines = toPositiveInteger(diff.deletedLines ?? 0);
    if (addedLines > 0 || deletedLines > 0) {
        return addedLines + deletedLines;
    }
    return deriveEffectiveChangedLinesFromHunks(diff);
};

export const hasRiskChange = (diff: FileDiff | null | undefined, riskPatterns: string[]): boolean => {
    if (!diff || diff.hunks.length === 0) return false;
    const candidates = (diff.addedContentLines?.length ? diff.addedContentLines : diff.hunks.flatMap(h => h.lines));
    if (candidates.length === 0) return false;
    const matchers = compileRiskPatterns(riskPatterns);
    if (matchers.length === 0) return false;
    return candidates.some(line => matchers.some(m => m.test(line)));
};

/** 按漏斗级别判断是否存在“应跳过自动复审”的诊断（error 或 warning） */
const shouldSkipByDiagnostics = (
    diagnostics: Array<{ severity: AutoReviewDiagnosticSeverity }>,
    funnelSeverity: AutoReviewFunnelSeverity
): boolean => {
    if (funnelSeverity === 'off') return false;
    const hasError = diagnostics.some(d => d.severity === 'error');
    const hasWarning = diagnostics.some(d => d.severity === 'warning');
    return funnelSeverity === 'warning' ? (hasError || hasWarning) : hasError;
};

export const evaluateAutoReviewGate = (input: AutoReviewGateInput): AutoReviewGateDecision => {
    if (input.trigger !== 'save') {
        return {
            skip: false,
            effectiveChangedLines: 0,
            riskMatched: false,
        };
    }

    const effectiveChangedLines = getEffectiveChangedLines(input.diff);
    const riskMatched = hasRiskChange(input.diff, input.config.riskPatterns);

    if (
        input.config.skipSameContent
        && input.savedContentHash
        && input.lastReviewedContentHash
        && input.savedContentHash === input.lastReviewedContentHash
    ) {
        return {
            skip: true,
            reason: 'same_content',
            effectiveChangedLines,
            riskMatched,
        };
    }

    if (!input.diff || input.diff.hunks.length === 0) {
        return {
            skip: true,
            reason: 'no_pending_diff',
            effectiveChangedLines,
            riskMatched,
        };
    }

    if (input.diff.formatOnly === true || input.diff.commentOnly === true) {
        return {
            skip: true,
            reason: 'noise_only_change',
            effectiveChangedLines,
            riskMatched,
        };
    }

    if (shouldSkipByDiagnostics(input.diagnostics, input.config.funnelLintSeverity)) {
        return {
            skip: true,
            reason: 'diagnostic_funnel',
            effectiveChangedLines,
            riskMatched,
        };
    }

    if (
        input.config.minEffectiveChangedLines > 0
        && effectiveChangedLines < input.config.minEffectiveChangedLines
        && !riskMatched
    ) {
        return {
            skip: true,
            reason: 'small_low_risk_change',
            effectiveChangedLines,
            riskMatched,
        };
    }

    return {
        skip: false,
        effectiveChangedLines,
        riskMatched,
    };
};
