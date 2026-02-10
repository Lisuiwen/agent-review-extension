/**
 * 配置合并（默认 + 用户配置，含 AI 环境变量回退）
 *
 * 供 ConfigManager 在 loadConfig 中调用。
 */

import type { AgentReviewConfig } from '../types/config';

/**
 * 合并默认配置与已解析环境变量的用户配置；resolveEnv 用于 AI 端点的环境变量回退
 */
export const mergeConfig = (
    defaultConfig: AgentReviewConfig,
    resolvedUserConfig: Partial<AgentReviewConfig>,
    resolveEnv: (value: string) => string
): AgentReviewConfig => {
    const merged: AgentReviewConfig = {
        ...defaultConfig,
        ...resolvedUserConfig,
        rules: {
            ...defaultConfig.rules,
            ...resolvedUserConfig.rules,
            code_quality: resolvedUserConfig.rules?.code_quality
                ? { ...defaultConfig.rules.code_quality, ...resolvedUserConfig.rules.code_quality }
                : defaultConfig.rules.code_quality,
            naming_convention: resolvedUserConfig.rules?.naming_convention
                ? { ...defaultConfig.rules.naming_convention, ...resolvedUserConfig.rules.naming_convention }
                : defaultConfig.rules.naming_convention,
            security: resolvedUserConfig.rules?.security
                ? { ...defaultConfig.rules.security, ...resolvedUserConfig.rules.security }
                : defaultConfig.rules.security,
            business_logic: resolvedUserConfig.rules?.business_logic
                ? { ...defaultConfig.rules.business_logic, ...resolvedUserConfig.rules.business_logic }
                : defaultConfig.rules.business_logic,
        },
        git_hooks: (() => {
            const defaultHooks = defaultConfig.git_hooks || {
                auto_install: true,
                pre_commit_enabled: true,
                allow_commit_once: true,
            };
            if (resolvedUserConfig.git_hooks) {
                return {
                    auto_install: resolvedUserConfig.git_hooks.auto_install ?? defaultHooks.auto_install,
                    pre_commit_enabled: resolvedUserConfig.git_hooks.pre_commit_enabled ?? defaultHooks.pre_commit_enabled,
                    allow_commit_once: resolvedUserConfig.git_hooks.allow_commit_once ?? defaultHooks.allow_commit_once,
                };
            }
            return defaultHooks;
        })(),
        exclusions: {
            files: resolvedUserConfig.exclusions?.files ?? defaultConfig.exclusions?.files ?? [],
            directories: resolvedUserConfig.exclusions?.directories ?? defaultConfig.exclusions?.directories ?? [],
        },
        ast: (() => {
            const defaultAst = defaultConfig.ast ?? {
                enabled: false,
                max_node_lines: 200,
                max_file_lines: 2000,
                preview_only: false,
            };
            if (!resolvedUserConfig.ast) return defaultAst;
            return {
                enabled: resolvedUserConfig.ast.enabled ?? defaultAst.enabled,
                max_node_lines: resolvedUserConfig.ast.max_node_lines ?? defaultAst.max_node_lines,
                max_file_lines: resolvedUserConfig.ast.max_file_lines ?? defaultAst.max_file_lines,
                preview_only: resolvedUserConfig.ast.preview_only ?? defaultAst.preview_only,
            };
        })(),
        runtime_log: (() => {
            const defaultRuntimeLog = defaultConfig.runtime_log ?? {
                enabled: true,
                level: 'info',
                retention_days: 14,
                file_mode: 'per_run',
                format: 'jsonl',
            };
            if (!resolvedUserConfig.runtime_log) return defaultRuntimeLog;
            return {
                enabled: resolvedUserConfig.runtime_log.enabled ?? defaultRuntimeLog.enabled,
                level: resolvedUserConfig.runtime_log.level ?? defaultRuntimeLog.level,
                retention_days: resolvedUserConfig.runtime_log.retention_days ?? defaultRuntimeLog.retention_days,
                file_mode: resolvedUserConfig.runtime_log.file_mode ?? defaultRuntimeLog.file_mode,
                format: resolvedUserConfig.runtime_log.format ?? defaultRuntimeLog.format,
            };
        })(),
    };

    if (merged.ai_review) {
        if (!merged.ai_review.api_endpoint) {
            merged.ai_review.api_endpoint = resolveEnv('${AGENTREVIEW_AI_API_ENDPOINT}');
        }
        if (!merged.ai_review.api_key) {
            merged.ai_review.api_key = resolveEnv('${AGENTREVIEW_AI_API_KEY}');
        }
        const envModel = resolveEnv('${AGENTREVIEW_AI_MODEL}');
        if (envModel && !envModel.includes('${') && !merged.ai_review.model) {
            merged.ai_review.model = envModel;
        }
    }

    return merged;
};
