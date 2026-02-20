/**
 * 配置相关类型定义
 *
 * 集中维护 AgentReviewConfig、RuleConfig 等，供 config、core、shared 等模块引用。
 */

/**
 * 规则配置接口
 * 每个规则组（如 code_quality、naming_convention）都遵循这个结构
 */
export interface RuleConfig {
    enabled: boolean;  // 是否启用这个规则组
    action: 'block_commit' | 'warning' | 'log';  // 违反规则时的行为：阻止提交/警告/仅记录
    [key: string]: any;  // 允许添加其他规则特定的配置项
}

/**
 * 配置文件的数据结构定义
 * 这个接口定义了配置文件的完整结构
 */
export interface AgentReviewConfig {
    version: string;
    rules: {
        enabled: boolean;
        strict_mode: boolean;
        builtin_rules_enabled?: boolean;  // 是否启用内置规则引擎（默认false，避免与项目自有规则冲突）
        diff_only?: boolean;              // staged 审查时仅扫描变更行（默认 true）
        code_quality?: RuleConfig;
        security?: RuleConfig;
        naming_convention?: RuleConfig;
        business_logic?: RuleConfig;
    };
    ai_review?: {
        enabled: boolean;
        api_format?: 'openai' | 'custom';  // API格式：OpenAI兼容或自定义
        api_endpoint: string;              // API端点URL
        api_key?: string;                  // API密钥（支持环境变量）
        model?: string;                     // 模型名称（需在设置或 .env 中配置，无默认值）
        timeout: number;                    // 超时时间（毫秒）
        temperature?: number;                // 温度参数（0-2）
        max_tokens?: number;                // 最大token数
        system_prompt?: string;             // 系统提示词
        retry_count?: number;               // 重试次数
        retry_delay?: number;               // 重试延迟（毫秒）
        skip_on_blocking_errors?: boolean;  // 遇到阻止提交错误时跳过AI审查
        diff_only?: boolean;                // staged 审查时仅发送变更片段给 AI（默认 true）
        batching_mode?: 'file_count' | 'ast_snippet'; // 批次模式
        ast_snippet_budget?: number;        // AST 片段预算（每批次片段数量上限）
        ast_chunk_strategy?: 'even' | 'contiguous'; // 同一文件片段拆分策略
        batch_concurrency?: number;         // 批次并发数
        max_request_chars?: number;         // 单次请求字符数上限
        run_on_save?: boolean;              // 保存文件时自动触发审查（默认 false）
        run_on_save_debounce_ms?: number;   // 保存自动审查防抖时间（默认 1200ms）
        run_on_save_max_runs_per_minute?: number; // 保存自动审查每分钟最大执行次数（默认 4）
        run_on_save_skip_same_content?: boolean; // 保存内容与上次复审一致时跳过（默认 true）
        run_on_save_min_effective_changed_lines?: number; // 保存自动复审最小有效改动行数（默认 3，0 为关闭）
        run_on_save_risk_patterns?: string[]; // 保存自动复审风险特征正则列表（命中则不按小改动跳过）
        run_on_save_funnel_lint_severity?: 'off' | 'error' | 'warning'; // 保存自动复审 diagnostics 漏斗阈值（默认 error）
        enable_local_rebase?: boolean;      // 编辑期本地行号重映射（默认 true）
        large_change_line_threshold?: number; // 大改动阈值，超出仅标记 stale（默认 40）
        idle_recheck_enabled?: boolean;     // 编辑停顿后自动复审（默认 false）
        idle_recheck_ms?: number;           // 编辑停顿复审延迟（默认 2500ms）
        auto_review_max_parallel_files?: number; // 自动复审文件并发上限（默认 1）
        review_current_file_now_bypass_rate_limit?: boolean; // 立即复审命令是否绕过限频（默认 false）
        funnel_lint?: boolean;              // 漏斗模式：先看 diagnostics，再决定是否发 AI（默认 false）
        funnel_lint_severity?: 'error' | 'warning'; // 漏斗阈值：error=仅错误拦截，warning=警告及以上拦截
        ignore_format_only_diff?: boolean;  // 忽略仅格式/空白变更的 diff（默认 true）
        action: 'block_commit' | 'warning' | 'log';  // 违反规则时的行为
    };
    ast?: {
        enabled?: boolean;          // 是否启用 AST 片段模式（默认 false）
        max_node_lines?: number;   // 单个 AST 节点的最大行数
        max_file_lines?: number;   // 文件总行数超过阈值则回退
        include_lsp_context?: boolean; // 是否通过 LSP 补充外部定义上下文（默认 true）
        preview_only?: boolean;     // 为 true 时不调用大模型，仅打印将发送的 AST/变更切片内容
    };
    exclusions?: {
        files?: string[];
        directories?: string[];
    };
    runtime_log?: {
        enabled?: boolean;
        level?: 'info' | 'warn' | 'error' | 'debug';
        retention_days?: number;
        file_mode?: 'per_run';
        format?: 'jsonl';
        base_dir_mode?: 'workspace_docs_logs' | 'global_storage';
        human_readable?: {
            enabled?: boolean;
            granularity?: 'stage_summary' | 'events' | 'summary_with_key_events';
            auto_generate_on_run_end?: boolean;
        };
    };
}
