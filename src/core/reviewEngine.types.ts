/**
 * 审查引擎内部类型
 *
 * 供 reviewEngine 及 runSummary 等子模块使用，避免主文件内重复定义。
 */

import type { FileDiff } from '../utils/diffTypes';
import type { AffectedScopeResult } from '../utils/astScope';
import type { ReviewResult } from '../types/review';
import type { RuntimeTraceSession } from '../utils/runtimeTraceLogger';

/** 审查范围提示：AST 或行号范围 */
export type ReviewScopeHint = {
    startLine: number;
    endLine: number;
    source: 'ast' | 'line';
};

/** 单次 review 调用可选参数：diff、trace 会话、AST 覆盖等 */
export type ReviewRunOptions = {
    diffByFile?: Map<string, FileDiff>;
    traceSession?: RuntimeTraceSession | null;
    astSnippetsByFileOverride?: Map<string, AffectedScopeResult>;
};

/** 待审查上下文：无待变更或已审查完成 */
export type PendingReviewContext = {
    result: ReviewResult;
    pendingFiles: string[];
    reason: 'no_pending_changes' | 'reviewed';
};

/** 已复审行范围 */
export type ReviewedRange = {
    startLine: number;
    endLine: number;
};

/** 单文件保存复审结果上下文 */
export type SavedFileReviewContext = {
    result: ReviewResult;
    reviewedRanges: ReviewedRange[];
    mode: 'diff' | 'full';
    reason: 'reviewed' | 'fallback_full' | 'no_target_diff';
};

/** 项目诊断项（来自 LSP/ESLint 等），用于漏斗与 project rule */
export type ProjectDiagnosticItem = {
    line: number;
    column: number;
    message: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    code?: string;
    range?: { startLine: number; endLine: number };
};
