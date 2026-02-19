/**
 * Diff 相关类型定义
 *
 * 用于基于 Git staged diff 的增量审查：仅对变更行/片段做规则与 AI 审查。
 * 行号以「新文件」为基准，便于问题定位与编辑器跳转。
 */

/**
 * 单个 diff hunk（一段连续变更）
 * 以「新文件」行号为基准
 */
export interface DiffHunk {
    /** 新文件中该 hunk 的起始行号（从 1 开始） */
    newStart: number;
    /** 新文件中该 hunk 的行数 */
    newCount: number;
    /** 新文件侧的行内容（不含 +/- 前缀，与 newCount 对应） */
    lines: string[];
}

/**
 * 单个文件的 diff 信息
 * 新增文件可表示为单一 hunk 覆盖全文件；删除文件可为空 hunks。
 */
export interface FileDiff {
    /** 文件路径（与审查时使用的路径一致，可为相对或绝对） */
    path: string;
    /** 该文件的所有 hunks */
    hunks: DiffHunk[];
    /** 是否仅包含格式/空白差异（通过 git diff -w --ignore-blank-lines --ignore-cr-at-eol 判定） */
    formatOnly?: boolean;
}
