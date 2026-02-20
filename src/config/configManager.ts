/**
 * 配置管理模块
 *
 * 此文件负责读取和管理插件的配置文件
 * 4. 提供配置访问接口
 *
 * - 项目根目录：.agentreview.yaml
 *
 * ```yaml
 * version: "1.0"
 * rules:
 *   enabled: true
 *   strict_mode: false
 *   builtin_rules_enabled: false  # 是否启用内置规则引擎（若检测到项目规则文件且未显式配置，会自动开启）
 *   naming_convention:
 *     enabled: true
 *     action: "block_commit"
 *     no_space_in_filename: true
 *   code_quality:
 *     enabled: true
 *     action: "block_commit"
 *     no_todo: true
 *     no_debugger: true
 *     no_todo_pattern: "(TODO|FIXME|XXX)"  # 可选：自定义规则表达式模式
 * ```
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';
import type { AgentReviewConfig, RuleConfig } from '../types/config';
import { loadYamlFromPath, loadPluginYaml } from './configLoader';
import { setupConfigWatcher } from './configWatcher';
import { resolveEnvVariables, resolveEnvInConfig } from './envResolver';
import { mergeConfig as mergeConfigFn } from './configMerger';

export type { AgentReviewConfig, RuleConfig } from '../types/config';

/**
 * 配置管理器类
 *
 * 使用示例：
 * const configManager = new ConfigManager();
 * await configManager.initialize();
 * const config = configManager.getConfig();
 */
export class ConfigManager implements vscode.Disposable {
    private logger: Logger;                    // 日志记录器
    private config: AgentReviewConfig | null = null;  // 缓存的配置
    private configPath: string;                // 配置文件的完整路径
    private envPath: string;                   // .env 文件的完整路径
    private extensionPath: string | undefined;  // 扩展安装路径（用于单工作区时回退加载 .env）
    private envVars: Map<string, string> = new Map();  // .env 文件加载的环境变量
    private watcherDisposable: ReturnType<typeof setupConfigWatcher> | undefined;  // 配置/.env 监听（含防抖）

    /**
     * 初始化配置管理器，确定配置文件的位置
     */
    constructor() {
        this.logger = new Logger('ConfigManager');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        this.configPath = workspaceFolder 
            ? path.join(workspaceFolder.uri.fsPath, '.agentreview.yaml')
            : '.agentreview.yaml';
        this.envPath = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, '.env')
            : '.env';
    }

    private getExplicitSetting<T>(settings: vscode.WorkspaceConfiguration, key: string): T | undefined {
        const inspected = settings.inspect<T>(key);
        if (!inspected) return undefined;
        return (inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue) as T | undefined;
    }

    /**
     * 初始化配置管理器
     * @param context - 扩展上下文，传入时用于单工作区下从扩展目录回退加载 .env
     */
    async initialize(context?: vscode.ExtensionContext): Promise<void> {
        this.extensionPath = context?.extensionPath;
        await this.loadEnvFile();
        // 然后加载配置文件
        await this.loadConfig();
        this.setupFileWatcher();
    }

    /**
     * 当配置文件或 .env 文件变更时，自动重新加载配置
     */
    private setupFileWatcher(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.logger.warn('未找到工作区，无法设置配置文件监视器');
            return;
        }
        const onReload = async () => {
            this.logger.info('检测到配置/.env 变更，重新加载配置');
            await this.loadEnvFile();
            await this.reloadConfig();
        };
        this.watcherDisposable = setupConfigWatcher(
            workspaceFolder,
            this.configPath,
            this.envPath,
            onReload,
            300
        );
        this.logger.info('配置文件监听器已设置（含 .env 文件监听）');
    }

    /**
     * 重新加载配置文件
     * - 会保留旧配置，如果新配置加载失败，继续使用旧配置
     */
    private async reloadConfig(): Promise<void> {
        const oldConfig = this.config;
        
        try {
            const fileExists = fs.existsSync(this.configPath);
            
            // 尝试重新加载配置
            const newConfig = await this.loadConfig();
            
            // 如果文件存在但加载后配置与默认配置相同，可能是加载失败了
            if (fileExists && oldConfig) {
                const defaultConfig = this.getDefaultConfig();
                // 简单检查：如果新配置与默认配置完全相同，可能是加载失败
                // 这里使用 JSON 字符串比较，虽然不精确，但对于 MVP 足够
                const newConfigStr = this.stableStringify(newConfig);
                const defaultConfigStr = this.stableStringify(defaultConfig);
                const oldConfigStr = this.stableStringify(oldConfig);
                
                if (newConfigStr === defaultConfigStr && oldConfigStr !== defaultConfigStr) {
                    this.config = oldConfig;
                    this.logger.warn('配置文件可能加载失败，保持使用旧配置');
                    vscode.window.showWarningMessage(
                        '⚠️ AgentReview 配置加载可能失败，已恢复使用旧配置。请检查配置文件格式。'
                    );
                    return;
                }
            }
            
            // 加载成功，显示通知
            this.logger.info('配置文件重新加载成功');
            vscode.window.showInformationMessage('AgentReview 配置已更新');
        } catch (error) {
            // 加载失败，恢复旧配置
            this.logger.error('配置文件重新加载失败，保持使用旧配置', error);
            if (oldConfig) {
                this.config = oldConfig;
                vscode.window.showWarningMessage(
                    '⚠️ AgentReview 配置加载失败，已恢复使用旧配置。请检查配置文件格式。'
                );
            } else {
                // 如果没有旧配置，使用默认配置
                this.config = this.getDefaultConfig();
                vscode.window.showWarningMessage(
                    '⚠️ AgentReview 配置加载失败，已使用默认配置。请检查配置文件格式。'
                );
            }
        }
    }

    /**
     * 从 VSCode 工作区/用户设置中读取 agentreview.ai.* 并映射为 ai_review 配置键，未设置则返回 undefined。
     */
    private loadAIConfigFromSettings(): Partial<AgentReviewConfig['ai_review']> | undefined {
        const settings = vscode.workspace.getConfiguration('agentreview');

        const aiConfig: Record<string, unknown> = {};
        const mappings: { key: string; configKey: string }[] = [
            { key: 'ai.enabled', configKey: 'enabled' },
            { key: 'ai.apiFormat', configKey: 'api_format' },
            { key: 'ai.apiEndpoint', configKey: 'api_endpoint' },
            { key: 'ai.apiKey', configKey: 'api_key' },
            { key: 'ai.model', configKey: 'model' },
            { key: 'ai.timeout', configKey: 'timeout' },
            { key: 'ai.temperature', configKey: 'temperature' },
            { key: 'ai.maxTokens', configKey: 'max_tokens' },
            { key: 'ai.systemPrompt', configKey: 'system_prompt' },
            { key: 'ai.retryCount', configKey: 'retry_count' },
            { key: 'ai.retryDelay', configKey: 'retry_delay' },
            { key: 'ai.action', configKey: 'action' },
            { key: 'ai.diffOnly', configKey: 'diff_only' },
            { key: 'ai.batchingMode', configKey: 'batching_mode' },
            { key: 'ai.astSnippetBudget', configKey: 'ast_snippet_budget' },
            { key: 'ai.astChunkStrategy', configKey: 'ast_chunk_strategy' },
            { key: 'ai.batchConcurrency', configKey: 'batch_concurrency' },
            { key: 'ai.maxRequestChars', configKey: 'max_request_chars' },
            { key: 'ai.runOnSave', configKey: 'run_on_save' },
            { key: 'ai.runOnSaveDebounceMs', configKey: 'run_on_save_debounce_ms' },
            { key: 'ai.runOnSaveMaxRunsPerMinute', configKey: 'run_on_save_max_runs_per_minute' },
            { key: 'ai.runOnSaveSkipSameContent', configKey: 'run_on_save_skip_same_content' },
            { key: 'ai.runOnSaveMinEffectiveChangedLines', configKey: 'run_on_save_min_effective_changed_lines' },
            { key: 'ai.runOnSaveRiskPatterns', configKey: 'run_on_save_risk_patterns' },
            { key: 'ai.runOnSaveFunnelLintSeverity', configKey: 'run_on_save_funnel_lint_severity' },
            { key: 'ai.enableLocalRebase', configKey: 'enable_local_rebase' },
            { key: 'ai.largeChangeLineThreshold', configKey: 'large_change_line_threshold' },
            { key: 'ai.idleRecheckEnabled', configKey: 'idle_recheck_enabled' },
            { key: 'ai.idleRecheckMs', configKey: 'idle_recheck_ms' },
            { key: 'ai.autoReviewMaxParallelFiles', configKey: 'auto_review_max_parallel_files' },
            { key: 'ai.reviewCurrentFileNowBypassRateLimit', configKey: 'review_current_file_now_bypass_rate_limit' },
            { key: 'ai.funnelLint', configKey: 'funnel_lint' },
            { key: 'ai.funnelLintSeverity', configKey: 'funnel_lint_severity' },
            { key: 'ai.ignoreFormatOnlyDiff', configKey: 'ignore_format_only_diff' },
        ];
        for (const { key, configKey } of mappings) {
            const val = this.getExplicitSetting<unknown>(settings, key);
            if (val !== undefined) {
                (aiConfig as any)[configKey] = val;
            }
        }
        if (Object.keys(aiConfig).length === 0) return undefined;
        return resolveEnvInConfig(aiConfig, this.envVars, this.logger) as Partial<AgentReviewConfig['ai_review']>;
    }

    /**
     * 从 VSCode Settings 加载运行时日志配置
     * 优先级：Settings > YAML > 默认
     */
    private loadRuntimeLogConfigFromSettings(): Partial<NonNullable<AgentReviewConfig['runtime_log']>> | undefined {
        const settings = vscode.workspace.getConfiguration('agentreview');
        const runtimeLogConfig: Partial<NonNullable<AgentReviewConfig['runtime_log']>> = {};
        const enabled = this.getExplicitSetting<boolean>(settings, 'runtimeLog.enabled');
        if (enabled !== undefined) {
            runtimeLogConfig.enabled = enabled;
        }
        const level = this.getExplicitSetting<NonNullable<AgentReviewConfig['runtime_log']>['level']>(
            settings,
            'runtimeLog.level'
        );
        if (level !== undefined) {
            runtimeLogConfig.level = level;
        }
        const retentionDays = this.getExplicitSetting<number>(settings, 'runtimeLog.retentionDays');
        if (retentionDays !== undefined) {
            runtimeLogConfig.retention_days = retentionDays;
        }
        const fileMode = this.getExplicitSetting<NonNullable<AgentReviewConfig['runtime_log']>['file_mode']>(
            settings,
            'runtimeLog.fileMode'
        );
        if (fileMode !== undefined) {
            runtimeLogConfig.file_mode = fileMode;
        }
        const format = this.getExplicitSetting<NonNullable<AgentReviewConfig['runtime_log']>['format']>(
            settings,
            'runtimeLog.format'
        );
        if (format !== undefined) {
            runtimeLogConfig.format = format;
        }
        const baseDirMode = this.getExplicitSetting<NonNullable<AgentReviewConfig['runtime_log']>['base_dir_mode']>(
            settings,
            'runtimeLog.baseDirMode'
        );
        if (baseDirMode !== undefined) {
            runtimeLogConfig.base_dir_mode = baseDirMode;
        }

        const humanReadableEnabled = this.getExplicitSetting<boolean>(settings, 'runtimeLog.humanReadable.enabled');
        const humanReadableGranularity = this.getExplicitSetting<
            NonNullable<NonNullable<AgentReviewConfig['runtime_log']>['human_readable']>['granularity']
        >(settings, 'runtimeLog.humanReadable.granularity');
        const humanReadableAutoGenerate = this.getExplicitSetting<boolean>(
            settings,
            'runtimeLog.humanReadable.autoGenerateOnRunEnd'
        );

        if (
            humanReadableEnabled !== undefined
            || humanReadableGranularity !== undefined
            || humanReadableAutoGenerate !== undefined
        ) {
            runtimeLogConfig.human_readable = {
                ...(humanReadableEnabled !== undefined ? { enabled: humanReadableEnabled } : {}),
                ...(humanReadableGranularity !== undefined ? { granularity: humanReadableGranularity } : {}),
                ...(humanReadableAutoGenerate !== undefined ? { auto_generate_on_run_end: humanReadableAutoGenerate } : {}),
            };
        }

        if (Object.keys(runtimeLogConfig).length === 0) {
            return undefined;
        }

        return runtimeLogConfig;
    }

    /**
     * 加载配置文件
     *
     * 1. 获取默认配置作为基础
     * 2. 从 YAML 文件加载配置（若存在）
     * 3. 从 VSCode Settings 加载 AI 配置（优先级最高）
     *
     * @returns 加载后的配置对象
     */
    async loadConfig(): Promise<AgentReviewConfig> {
        this.logger.info(`加载配置文件: ${this.configPath}`);
        // 每次加载配置前先重新加载 .env，以便使用最新的环境变量（含仅用 .env 配置端点的情况）
        await this.loadEnvFile();
        // 获取默认配置作为基础
        const defaultConfig = this.getDefaultConfig();
        
        try {
            let yamlConfig = await loadYamlFromPath(this.configPath);
            if (Object.keys(yamlConfig).length > 0) {
                this.logger.info('YAML 配置文件加载成功');
            } else {
                this.logger.info('YAML 配置文件不存在，跳过');
            }

            if (!yamlConfig.ai_review && this.extensionPath) {
                const pluginYaml = await loadPluginYaml(this.extensionPath);
                if (pluginYaml?.ai_review) {
                    yamlConfig = { ...yamlConfig, ai_review: pluginYaml.ai_review };
                    this.logger.info('已从扩展目录加载 AI 配置（插件侧默认）');
                }
            }

            // 步骤3：从 VSCode Settings 读取 AI 配置（优先级最高）
            const settingsAIConfig = this.loadAIConfigFromSettings();
            if (settingsAIConfig) {
                this.logger.info('从 VSCode Settings 加载 AI 配置');
                const defaultAIConfig = {
                    enabled: false as boolean,
                    api_endpoint: '' as string,
                    timeout: 30000 as number,
                    action: 'warning' as const
                };
                
                const existingAIConfig = yamlConfig.ai_review || null;
                
                const enabledValue = settingsAIConfig.enabled !== undefined 
                    ? settingsAIConfig.enabled 
                    : (existingAIConfig?.enabled ?? defaultAIConfig.enabled);
                // 若未配置端点，尝试使用环境变量占位符，便于从 .env 解析
                const apiEndpointValue = (settingsAIConfig.api_endpoint ?? existingAIConfig?.api_endpoint ?? defaultAIConfig.api_endpoint)
                    || '${AGENTREVIEW_AI_API_ENDPOINT}';
                const timeoutValue = settingsAIConfig.timeout !== undefined 
                    ? settingsAIConfig.timeout 
                    : (existingAIConfig?.timeout ?? defaultAIConfig.timeout);
                const actionValue = settingsAIConfig.action || existingAIConfig?.action || defaultAIConfig.action;
                
                // 构建合并后的配置对象
                const mergedAIConfig: AgentReviewConfig['ai_review'] = {
                    // 必填字段（已确保有值）
                    enabled: enabledValue,
                    api_endpoint: apiEndpointValue,
                    timeout: timeoutValue,
                    action: actionValue,
                    ...(settingsAIConfig.api_format !== undefined && { api_format: settingsAIConfig.api_format }),
                    ...(existingAIConfig?.api_format !== undefined && settingsAIConfig.api_format === undefined && { api_format: existingAIConfig.api_format }),
                    ...(settingsAIConfig.api_key !== undefined && { api_key: settingsAIConfig.api_key }),
                    ...(existingAIConfig?.api_key !== undefined && settingsAIConfig.api_key === undefined && { api_key: existingAIConfig.api_key }),
                    ...(settingsAIConfig.model !== undefined && { model: settingsAIConfig.model }),
                    ...(existingAIConfig?.model !== undefined && settingsAIConfig.model === undefined && { model: existingAIConfig.model }),
                    ...(settingsAIConfig.temperature !== undefined && { temperature: settingsAIConfig.temperature }),
                    ...(existingAIConfig?.temperature !== undefined && settingsAIConfig.temperature === undefined && { temperature: existingAIConfig.temperature }),
                    ...(settingsAIConfig.max_tokens !== undefined && { max_tokens: settingsAIConfig.max_tokens }),
                    ...(existingAIConfig?.max_tokens !== undefined && settingsAIConfig.max_tokens === undefined && { max_tokens: existingAIConfig.max_tokens }),
                    ...(settingsAIConfig.system_prompt !== undefined && { system_prompt: settingsAIConfig.system_prompt }),
                    ...(existingAIConfig?.system_prompt !== undefined && settingsAIConfig.system_prompt === undefined && { system_prompt: existingAIConfig.system_prompt }),
                    ...(settingsAIConfig.retry_count !== undefined && { retry_count: settingsAIConfig.retry_count }),
                    ...(existingAIConfig?.retry_count !== undefined && settingsAIConfig.retry_count === undefined && { retry_count: existingAIConfig.retry_count }),
                    ...(settingsAIConfig.retry_delay !== undefined && { retry_delay: settingsAIConfig.retry_delay }),
                    ...(existingAIConfig?.retry_delay !== undefined && settingsAIConfig.retry_delay === undefined && { retry_delay: existingAIConfig.retry_delay }),
                    diff_only: settingsAIConfig.diff_only ?? existingAIConfig?.diff_only ?? true,
                    run_on_save: settingsAIConfig.run_on_save ?? existingAIConfig?.run_on_save ?? false,
                    run_on_save_debounce_ms:
                        settingsAIConfig.run_on_save_debounce_ms
                        ?? existingAIConfig?.run_on_save_debounce_ms
                        ?? 1200,
                    run_on_save_max_runs_per_minute:
                        settingsAIConfig.run_on_save_max_runs_per_minute
                        ?? existingAIConfig?.run_on_save_max_runs_per_minute
                        ?? 4,
                    run_on_save_skip_same_content:
                        settingsAIConfig.run_on_save_skip_same_content
                        ?? existingAIConfig?.run_on_save_skip_same_content
                        ?? true,
                    run_on_save_min_effective_changed_lines:
                        settingsAIConfig.run_on_save_min_effective_changed_lines
                        ?? existingAIConfig?.run_on_save_min_effective_changed_lines
                        ?? 3,
                    run_on_save_risk_patterns:
                        settingsAIConfig.run_on_save_risk_patterns
                        ?? existingAIConfig?.run_on_save_risk_patterns,
                    run_on_save_funnel_lint_severity:
                        settingsAIConfig.run_on_save_funnel_lint_severity
                        ?? existingAIConfig?.run_on_save_funnel_lint_severity
                        ?? 'error',
                    enable_local_rebase:
                        settingsAIConfig.enable_local_rebase
                        ?? existingAIConfig?.enable_local_rebase
                        ?? true,
                    large_change_line_threshold:
                        settingsAIConfig.large_change_line_threshold
                        ?? existingAIConfig?.large_change_line_threshold
                        ?? 40,
                    idle_recheck_enabled:
                        settingsAIConfig.idle_recheck_enabled
                        ?? existingAIConfig?.idle_recheck_enabled
                        ?? false,
                    idle_recheck_ms:
                        settingsAIConfig.idle_recheck_ms
                        ?? existingAIConfig?.idle_recheck_ms
                        ?? 2500,
                    auto_review_max_parallel_files:
                        settingsAIConfig.auto_review_max_parallel_files
                        ?? existingAIConfig?.auto_review_max_parallel_files
                        ?? 1,
                    review_current_file_now_bypass_rate_limit:
                        settingsAIConfig.review_current_file_now_bypass_rate_limit
                        ?? existingAIConfig?.review_current_file_now_bypass_rate_limit
                        ?? false,
                    funnel_lint: settingsAIConfig.funnel_lint ?? existingAIConfig?.funnel_lint ?? false,
                    funnel_lint_severity:
                        settingsAIConfig.funnel_lint_severity
                        ?? existingAIConfig?.funnel_lint_severity
                        ?? 'error',
                    ignore_format_only_diff:
                        settingsAIConfig.ignore_format_only_diff
                        ?? existingAIConfig?.ignore_format_only_diff
                        ?? true,
                    batching_mode: settingsAIConfig.batching_mode ?? existingAIConfig?.batching_mode ?? 'file_count',
                    ast_snippet_budget: settingsAIConfig.ast_snippet_budget ?? existingAIConfig?.ast_snippet_budget ?? 25,
                    ast_chunk_strategy: settingsAIConfig.ast_chunk_strategy ?? existingAIConfig?.ast_chunk_strategy ?? 'even',
                    batch_concurrency: settingsAIConfig.batch_concurrency ?? existingAIConfig?.batch_concurrency ?? 2,
                    max_request_chars: settingsAIConfig.max_request_chars ?? existingAIConfig?.max_request_chars ?? 50000,
                };
                yamlConfig.ai_review = mergedAIConfig;
            }

            const settingsRuntimeLogConfig = this.loadRuntimeLogConfigFromSettings();
            if (settingsRuntimeLogConfig) {
                this.logger.info('从 VSCode Settings 加载运行时日志配置');
                const existingRuntimeLog = yamlConfig.runtime_log || null;
                yamlConfig.runtime_log = {
                    enabled: settingsRuntimeLogConfig.enabled ?? existingRuntimeLog?.enabled ?? true,
                    level: settingsRuntimeLogConfig.level ?? existingRuntimeLog?.level ?? 'info',
                    retention_days: settingsRuntimeLogConfig.retention_days ?? existingRuntimeLog?.retention_days ?? 14,
                    file_mode: settingsRuntimeLogConfig.file_mode ?? existingRuntimeLog?.file_mode ?? 'per_run',
                    format: settingsRuntimeLogConfig.format ?? existingRuntimeLog?.format ?? 'jsonl',
                    base_dir_mode: settingsRuntimeLogConfig.base_dir_mode ?? existingRuntimeLog?.base_dir_mode ?? 'workspace_docs_logs',
                    human_readable: {
                        enabled:
                            settingsRuntimeLogConfig.human_readable?.enabled
                            ?? existingRuntimeLog?.human_readable?.enabled
                            ?? true,
                        granularity:
                            settingsRuntimeLogConfig.human_readable?.granularity
                            ?? existingRuntimeLog?.human_readable?.granularity
                            ?? 'summary_with_key_events',
                        auto_generate_on_run_end:
                            settingsRuntimeLogConfig.human_readable?.auto_generate_on_run_end
                            ?? existingRuntimeLog?.human_readable?.auto_generate_on_run_end
                            ?? false,
                    },
                };
            }

            const resolvedUserConfig = resolveEnvInConfig(yamlConfig, this.envVars, this.logger) as Partial<AgentReviewConfig>;
            this.config = mergeConfigFn(defaultConfig, resolvedUserConfig, (s) =>
                resolveEnvVariables(s, this.envVars, this.logger)
            );

            this.logger.info('配置文件加载成功');
            
            return this.config;
        } catch (error) {
            // 步骤5：如果出错（文件格式错误、权限问题等），使用默认配置
            this.logger.error('加载配置文件失败', error);
            this.logger.warn('使用默认配置');
            this.config = defaultConfig;
            return this.config;
        }
    }

    /**
     * 加载 .env 文件：从工作区根目录（及多根时各根）读取并合并环境变量；
     */
    private parseAndMergeEnvContent(content: string, envPath: string, logPrefix = '.env 文件'): void {
        const lines = content.split(/\r?\n/);
        let lineNumber = 0;
        for (const line of lines) {
            lineNumber++;
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) continue;
            const match = trimmedLine.match(/^([^=#\s]+)\s*=\s*(.*)$/);
            if (match) {
                const key = match[1].trim();
                let value = match[2].trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
                }
                if (!process.env[key] && !this.envVars.has(key)) {
                    this.envVars.set(key, value);
                    this.logger.debug(`${logPrefix} 加载环境变量: ${key} (${envPath})`);
                }
            } else {
                this.logger.warn(`.env 文件第 ${lineNumber} 行格式不正确，已跳过: ${trimmedLine}`);
            }
        }
    }

    private async loadEnvFile(): Promise<void> {
        this.envVars.clear();
        const folders = vscode.workspace.workspaceFolders ?? [];
        const envPaths = folders.length > 0 ? folders.map(f => path.join(f.uri.fsPath, '.env')) : [this.envPath || '.env'];
        this.logger.info(`加载 .env 文件: ${envPaths.join(', ')}`);
        try {
            for (const envPath of envPaths) {
                if (!fs.existsSync(envPath)) {
                    this.logger.debug(`.env 文件不存在，跳过: ${envPath}`);
                    continue;
                }
                const content = await fs.promises.readFile(envPath, 'utf-8');
                this.parseAndMergeEnvContent(content, envPath);
            }
            if (this.envVars.size === 0 && this.extensionPath) {
                const fallbackEnv = path.join(this.extensionPath, '.env');
                if (fs.existsSync(fallbackEnv)) {
                    this.logger.info(`工作区未找到 .env，从扩展目录加载: ${fallbackEnv}`);
                    const content = await fs.promises.readFile(fallbackEnv, 'utf-8');
                    this.parseAndMergeEnvContent(content, fallbackEnv, '从扩展目录 .env');
                }
            }
            this.logger.info(`从 .env 文件加载了 ${this.envVars.size} 个环境变量`);
        } catch (error) {
            this.logger.error('加载 .env 文件失败', error);
        }
    }

    /**
     * 将对象按键排序后序列化为 JSON，用于配置比较；遇循环引用输出 [Circular]。
     */
    private stableStringify = (value: unknown): string => {
        const seen = new WeakSet<object>();
        const normalize = (input: unknown): unknown => {
            if (Array.isArray(input)) {
                return input.map(item => normalize(item));
            }
            if (input && typeof input === 'object') {
                const obj = input as Record<string, unknown>;
                if (seen.has(obj)) {
                    return '[Circular]';
                }
                seen.add(obj);
                return Object.keys(obj)
                    .sort()
                    .reduce<Record<string, unknown>>((acc, key) => {
                        acc[key] = normalize(obj[key]);
                        return acc;
                    }, {});
            }
            return input;
        };
        return JSON.stringify(normalize(value));
    };

    /**
     *
     * 用途：检测项目是否有自己的规则文件（如 eslint）
     */
    private detectProjectRuleConfig = (): boolean => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return false;
        }
        const root = workspaceFolder.uri.fsPath;
        const candidates = [
            '.eslintrc',
            '.eslintrc.js',
            '.eslintrc.cjs',
            '.eslintrc.json',
            '.eslintrc.yaml',
            '.eslintrc.yml',
            'eslint.config.js',
            'eslint.config.cjs',
            'eslint.config.mjs',
            'tsconfig.json',
            '.prettierrc',
            '.prettierrc.js',
            '.prettierrc.cjs',
            '.prettierrc.json',
            '.prettierrc.yaml',
            '.prettierrc.yml',
            'prettier.config.js',
            'prettier.config.cjs',
        ];
        return candidates.some(name => fs.existsSync(path.join(root, name)));
    };

    /**
     * 获取当前配置
     * 如果配置未加载，返回默认配置
     *
     * @returns 配置对象
     */
    getConfig(): AgentReviewConfig {
        return this.config || this.getDefaultConfig();
    }

    /**
     * 检测项目根目录是否存在常见规则配置文件（如 eslint/prettier），有则返回 'project'，否则 'builtin'。
     */
    getRuleSource(): 'project' | 'builtin' {
        return this.detectProjectRuleConfig() ? 'project' : 'builtin';
    }

    /**
     * 获取默认配置
     *
     * 这是插件的默认配置，当用户没有配置文件或配置项缺失时使用
     *
     * - naming_convention: 启用，阻止提交，检查文件名空格
     *
     * @returns 默认配置对象
     */
    private getDefaultConfig(): AgentReviewConfig {
        return {
            version: '1.0',
            rules: {
                enabled: true,
                strict_mode: false,
                builtin_rules_enabled: false,  // 默认值为 false；若探测到项目规则文件且未显式配置会自动开启
                diff_only: true,               // 默认仅扫描变更
                naming_convention: {
                    enabled: true,
                    action: 'block_commit',
                    no_space_in_filename: true,
                },
                code_quality: {
                    enabled: true,
                    action: 'block_commit',
                    no_todo: true,
                    no_debugger: true,
                },
            },
            ast: {
                enabled: true,
                max_node_lines: 200,
                max_file_lines: 2000,
                include_lsp_context: true, // 默认启用：为 AST 片段补充一层局部定义上下文
                preview_only: false,  // 默认 false：正常请求大模型；true 时仅打印切片不请求
            },
            exclusions: {
                files: [],
                directories: [],
            },
            runtime_log: {
                enabled: true,
                level: 'info',
                retention_days: 14,
                file_mode: 'per_run',
                format: 'jsonl',
                base_dir_mode: 'workspace_docs_logs',
                human_readable: {
                    enabled: true,
                    granularity: 'summary_with_key_events',
                    auto_generate_on_run_end: false,
                },
            },
        };
    }

    async saveConfig(config: AgentReviewConfig): Promise<void> {
        this.logger.info('保存配置文件');
    }

    /**
     * 清理资源
     */
    dispose(): void {
        this.watcherDisposable?.dispose();
        this.watcherDisposable = undefined;
        this.envVars.clear();
        this.logger.info('配置管理器资源已清理');
    }
}
