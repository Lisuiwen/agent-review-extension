/**
 * Diff 相关类型定义（re-export）
 *
 * 为保持现有 from './diffTypes' 的引用不报错，从 types/diff 统一 re-export。
 * 用于基于 Git staged diff 的增量审查。
 */

export type { DiffHunk, FileDiff } from '../types/diff';
