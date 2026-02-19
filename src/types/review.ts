/**
 * 审查相关类型定义
 *
 * 集中维护 ReviewIssue、ReviewResult 等，供 core、ui、commands 等模块引用。
 */

/**
 * 审查问题接口
 * 描述一个具体的代码问题，包含位置、消息、规则等信息
 */
export interface ReviewIssue {
    file: string;              // 文件路径
    line: number;              // 问题所在行号（从1开始）
    column: number;            // 问题所在列号（从1开始）
    message: string;            // 问题描述消息
    reason?: string;            // 问题原因说明（可选，优先用于详情浮层）
    rule: string;               // 触发的规则名称（如 'no_space_in_filename'）
    severity: 'error' | 'warning' | 'info';  // 严重程度
    astRange?: { startLine: number; endLine: number }; // AST 片段范围（1-based，可选）
    incremental?: boolean;      // 是否属于“本次增量问题”（true=增量，false/undefined=存量）
    ignored?: boolean;          // 是否被 @ai-ignore 覆盖（仅用于当前面板展示态）
    ignoreReason?: string;      // 放行原因（从 @ai-ignore 注释中提取，可选）
}

/**
 * 审查结果接口
 * 包含审查是否通过，以及按严重程度分类的问题列表
 */
export interface ReviewResult {
    passed: boolean;           // 审查是否通过（true=通过，false=未通过）
    errors: ReviewIssue[];     // 错误级别的问题（会阻止提交）
    warnings: ReviewIssue[];   // 警告级别的问题（不会阻止提交）
    info: ReviewIssue[];       // 信息级别的问题（仅记录）
}
