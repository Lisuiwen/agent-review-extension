/**
 * 审查面板相关类型与工具函数
 *
 * 本文件集中定义 ReviewPanel 使用的类型（StaleScopeHint、ReviewedRange、IgnoreLineMeta）
 * 以及 isAiIssue 等小工具，便于 reviewPanel、reviewPanelProvider、helpers 等模块复用。
 */

import type { ReviewIssue } from '../types/review';

/** 某文件内「待复审」范围提示，用于局部刷新或 AST/行号范围 */
export type StaleScopeHint = {
    startLine: number;
    endLine: number;
    source: 'ast' | 'line';
};

/** 已复审过的行范围（用于 applyFileReviewPatch 等） */
export type ReviewedRange = {
    startLine: number;
    endLine: number;
};

/** 某文件中 @ai-ignore 对应的行号集合及放行原因 */
export type IgnoreLineMeta = {
    ignoredLines: Set<number>;
    reasonByLine: Map<number, string>;
};

/** 判断是否为 AI 审查产生的问题（规则为 ai_review 或以 ai_ 开头） */
export const isAiIssue = (issue: ReviewIssue): boolean =>
    issue.rule === 'ai_review' || issue.rule.startsWith('ai_');
