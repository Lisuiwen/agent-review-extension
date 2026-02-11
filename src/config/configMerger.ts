/**
 * 配置合并：默认配置 + 用户配置，含 AI 环境变量回退。
 * 供 ConfigManager 在 loadConfig 中调用。
 */

import type { AgentReviewConfig } from '../types/config';

const DEFAULT_GIT_HOOKS = {
    auto_install: true,
    pre_commit_enabled: true,
    allow_commit_once: true,
} as const;

const DEFAULT_RUNTIME_LOG = {
    enabled: true,
    level: 'info' as const,
    retention_days: 14,
    file_mode: 'per_run' as const,
    format: 'jsonl' as const,
    base_dir_mode: 'workspace_docs_logs' as const,
    human_readable: {
        enabled: true,
        granularity: 'summary_with_key_events' as const,
        auto_generate_on_run_end: false,
    },
} as const;

/**
 * 合并默认配置与已解析环境变量的用户配置；resolveEnv 用于 AI 端点的环境变量回退。
 */
export const mergeConfig = (
    defaultConfig: AgentReviewConfig,
    resolvedUserConfig: Partial<AgentReviewConfig>,
    resolveEnv: (value: string) => string
): AgentReviewConfig => {
    const defaultRules = defaultConfig.rules;
    const userRules = resolvedUserConfig.rules;
    const defaultHooks = defaultConfig.git_hooks ?? DEFAULT_GIT_HOOKS;
    const defaultAst = defaultConfig.ast ?? { enabled: false, max_node_lines: 200, max_file_lines: 2000, preview_only: false };
    const defaultRuntimeLog = defaultConfig.runtime_log ?? DEFAULT_RUNTIME_LOG;
    const userRuntime = resolvedUserConfig.runtime_log;

    const merged: AgentReviewConfig = {
        ...defaultConfig,
        ...resolvedUserConfig,
        rules: {
            ...defaultRules,
            ...userRules,
            code_quality: userRules?.code_quality ? { ...defaultRules.code_quality, ...userRules.code_quality } : defaultRules.code_quality,
            naming_convention: userRules?.naming_convention ? { ...defaultRules.naming_convention, ...userRules.naming_convention } : defaultRules.naming_convention,
            security: userRules?.security ? { ...defaultRules.security, ...userRules.security } : defaultRules.security,
            business_logic: userRules?.business_logic ? { ...defaultRules.business_logic, ...userRules.business_logic } : defaultRules.business_logic,
        },
        git_hooks: resolvedUserConfig.git_hooks
            ? {
                auto_install: resolvedUserConfig.git_hooks.auto_install ?? defaultHooks.auto_install,
                pre_commit_enabled: resolvedUserConfig.git_hooks.pre_commit_enabled ?? defaultHooks.pre_commit_enabled,
                allow_commit_once: resolvedUserConfig.git_hooks.allow_commit_once ?? defaultHooks.allow_commit_once,
            }
            : defaultHooks,
        exclusions: {
            files: resolvedUserConfig.exclusions?.files ?? defaultConfig.exclusions?.files ?? [],
            directories: resolvedUserConfig.exclusions?.directories ?? defaultConfig.exclusions?.directories ?? [],
        },
        ast: resolvedUserConfig.ast
            ? {
                enabled: resolvedUserConfig.ast.enabled ?? defaultAst.enabled,
                max_node_lines: resolvedUserConfig.ast.max_node_lines ?? defaultAst.max_node_lines,
                max_file_lines: resolvedUserConfig.ast.max_file_lines ?? defaultAst.max_file_lines,
                preview_only: resolvedUserConfig.ast.preview_only ?? defaultAst.preview_only,
            }
            : defaultAst,
        runtime_log: userRuntime
            ? {
                enabled: userRuntime.enabled ?? defaultRuntimeLog.enabled,
                level: userRuntime.level ?? defaultRuntimeLog.level,
                retention_days: userRuntime.retention_days ?? defaultRuntimeLog.retention_days,
                file_mode: userRuntime.file_mode ?? defaultRuntimeLog.file_mode,
                format: userRuntime.format ?? defaultRuntimeLog.format,
                base_dir_mode: userRuntime.base_dir_mode ?? defaultRuntimeLog.base_dir_mode,
                human_readable: {
                    enabled: userRuntime.human_readable?.enabled ?? defaultRuntimeLog.human_readable?.enabled,
                    granularity: userRuntime.human_readable?.granularity ?? defaultRuntimeLog.human_readable?.granularity,
                    auto_generate_on_run_end: userRuntime.human_readable?.auto_generate_on_run_end ?? defaultRuntimeLog.human_readable?.auto_generate_on_run_end,
                },
            }
            : defaultRuntimeLog,
    };

    // AI 配置环境变量回退：端点、密钥、模型未配置时从环境变量填充
    if (merged.ai_review) {
        if (!merged.ai_review.api_endpoint) merged.ai_review.api_endpoint = resolveEnv('${AGENTREVIEW_AI_API_ENDPOINT}');
        if (!merged.ai_review.api_key) merged.ai_review.api_key = resolveEnv('${AGENTREVIEW_AI_API_KEY}');
        const envModel = resolveEnv('${AGENTREVIEW_AI_MODEL}');
        if (envModel && !envModel.includes('${') && !merged.ai_review.model) {
            merged.ai_review.model = envModel;
        }
    }

    return merged;
};
