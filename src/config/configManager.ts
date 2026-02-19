/**
 * 配置管理器
 * 
 * 这个文件负责读取和管理插件的配置文件
 * 
 * 主要功能：
 * 1. 读取项目根目录下的 .agentreview.yaml 配置文件
 * 2. 解析 YAML 格式的配置
 * 3. 合并用户配置和默认配置
 * 4. 提供配置访问接口
 * 
 * 配置文件位置：
 * - 项目根目录：.agentreview.yaml
 * - 如果配置文件不存在，会使用默认配置
 * 
 * 配置文件示例：
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
 *     action: "warning"
 *     no_todo: true
 *     no_todo_pattern: "(TODO|FIXME|XXX)"  # 可选：自定义正则表达式模式
 * git_hooks:
 *   auto_install: true
 *   pre_commit_enabled: true
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
import { getProjectRulesSummary as getProjectRulesSummaryImpl } from './projectRulesSummary';

// 为保持向后兼容，从 configManager 继续 export 类型（实际定义在 types/config）
export type { AgentReviewConfig, RuleConfig } from '../types/config';

/**
 * 配置管理器类
 * 
 * 使用方式：
 * ```typescript
 * const configManager = new ConfigManager();
 * await configManager.initialize();
 * const config = configManager.getConfig();
 * ```
 */
export class ConfigManager implements vscode.Disposable {
    private logger: Logger;                    // 日志记录器
    private config: AgentReviewConfig | null = null;  // 缓存的配置对象
    private configPath: string;                // 配置文件的完整路径
    private envPath: string;                   // .env文件的完整路径
    private extensionPath: string | undefined;  // 扩展安装目录（用于单工作区时回退加载 .env）
    private envVars: Map<string, string> = new Map();  // 从.env文件加载的环境变量
    private watcherDisposable: ReturnType<typeof setupConfigWatcher> | undefined;  // 配置与 .env 监听（含防抖）
    private projectRulesSummaryCache: { root: string; mtime: number; summary: string } | null = null;

    /**
     * 构造函数
     * 初始化配置管理器，确定配置文件的位置
     */
    constructor() {
        this.logger = new Logger('ConfigManager');
        // 获取当前工作区的根目录
        // vscode.workspace.workspaceFolders 是 VSCode 提供的 API，用于获取打开的工作区
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        // 配置文件路径：工作区根目录/.agentreview.yaml
        this.configPath = workspaceFolder 
            ? path.join(workspaceFolder.uri.fsPath, '.agentreview.yaml')
            : '.agentreview.yaml';
        // .env文件路径：工作区根目录/.env
        this.envPath = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, '.env')
            : '.env';
    }

    /** 仅当设置项被显式配置时返回值；workspaceFolder > workspace > global。避免 VSCode 默认值覆盖 YAML */
    private getExplicitSetting<T>(settings: vscode.WorkspaceConfiguration, key: string): T | undefined {
        const inspected = settings.inspect<T>(key);
        if (!inspected) return undefined;
        return (inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue) as T | undefined;
    }

    /**
     * 初始化配置管理器
     * 在插件激活时调用，加载配置文件并设置文件监听器
     * @param context - 扩展上下文，传入时用于单工作区下从扩展目录回退加载 .env
     */
    async initialize(context?: vscode.ExtensionContext): Promise<void> {
        this.extensionPath = context?.extensionPath;
        // 先加载.env文件（环境变量需要在配置加载前准备好）
        await this.loadEnvFile();
        // 然后加载配置文件
        await this.loadConfig();
        // 设置文件监听器
        this.setupFileWatcher();
    }

    /**
     * 设置配置文件监听器
     * 当配置文件或.env文件变更时，自动重新加载配置
     * 使用防抖机制，避免频繁触发重载
     */
    private setupFileWatcher(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.logger.warn('未找到工作区，无法设置配置文件监听器');
            return;
        }
        const onReload = async () => {
            this.logger.info('检测到配置或 .env 变更，重新加载配置');
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
        this.logger.info('配置文件监听器已设置（包括.env文件监听）');
    }

    /**
     * 重新加载配置文件
     * 这是配置文件变更时调用的方法，与 loadConfig 的区别是：
     * - 会保留旧配置，如果新配置加载失败，继续使用旧配置
     * - 会显示通知告知用户配置已更新
     */
    private async reloadConfig(): Promise<void> {
        // 保存旧配置，以便加载失败时恢复
        const oldConfig = this.config;
        
        try {
            // 检查文件是否存在
            const fileExists = fs.existsSync(this.configPath);
            
            // 尝试重新加载配置
            const newConfig = await this.loadConfig();
            
            // 如果文件存在但加载后配置与默认配置相同，可能是加载失败了
            // 这种情况下，如果之前有配置，保持使用旧配置
            if (fileExists && oldConfig) {
                const defaultConfig = this.getDefaultConfig();
                // 简单检查：如果新配置与默认配置完全相同，可能是加载失败
                // 这里使用 JSON 字符串比较，虽然不够精确，但对于 MVP 足够
                const newConfigStr = this.stableStringify(newConfig);
                const defaultConfigStr = this.stableStringify(defaultConfig);
                const oldConfigStr = this.stableStringify(oldConfig);
                
                if (newConfigStr === defaultConfigStr && oldConfigStr !== defaultConfigStr) {
                    // 可能是加载失败，恢复旧配置
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
            vscode.window.showInformationMessage('✓ AgentReview 配置已更新');
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
     * 从 VSCode Settings 读取 AI 审查配置。优先级：Settings > YAML > 默认。
     */
    private loadAIConfigFromSettings(): Partial<AgentReviewConfig['ai_review']> | undefined {
        const settings = vscode.workspace.getConfiguration('agentreview');
        if (!settings.get('ai') || typeof settings.get('ai') !== 'object') return undefined;

        const aiConfig: Record<string, unknown> = {};
        const mappings: { key: string; configKey: string; explicit?: boolean }[] = [
            { key: 'ai.enabled', configKey: 'enabled', explicit: true },
            { key: 'ai.apiFormat', configKey: 'api_format' },
            { key: 'ai.apiEndpoint', configKey: 'api_endpoint' },
            { key: 'ai.apiKey', configKey: 'api_key' },
            { key: 'ai.model', configKey: 'model' },
            { key: 'ai.timeout', configKey: 'timeout', explicit: true },
            { key: 'ai.temperature', configKey: 'temperature', explicit: true },
            { key: 'ai.maxTokens', configKey: 'max_tokens', explicit: true },
            { key: 'ai.systemPrompt', configKey: 'system_prompt' },
            { key: 'ai.retryCount', configKey: 'retry_count', explicit: true },
            { key: 'ai.retryDelay', configKey: 'retry_delay', explicit: true },
            { key: 'ai.action', configKey: 'action' },
            { key: 'ai.diffOnly', configKey: 'diff_only', explicit: true },
            { key: 'ai.batchingMode', configKey: 'batching_mode' },
            { key: 'ai.astSnippetBudget', configKey: 'ast_snippet_budget', explicit: true },
            { key: 'ai.astChunkStrategy', configKey: 'ast_chunk_strategy' },
            { key: 'ai.batchConcurrency', configKey: 'batch_concurrency', explicit: true },
            { key: 'ai.maxRequestChars', configKey: 'max_request_chars', explicit: true },
            { key: 'ai.runOnSave', configKey: 'run_on_save', explicit: true },
            { key: 'ai.funnelLint', configKey: 'funnel_lint', explicit: true },
            { key: 'ai.funnelLintSeverity', configKey: 'funnel_lint_severity' },
            { key: 'ai.ignoreFormatOnlyDiff', configKey: 'ignore_format_only_diff', explicit: true },
        ];
        for (const { key, configKey, explicit } of mappings) {
            const val = settings.get(key);
            if (explicit ? val !== undefined : val) {
                (aiConfig as any)[configKey] = val;
            }
        }
        if (Object.keys(aiConfig).length === 0) return undefined;
        return resolveEnvInConfig(aiConfig, this.envVars, this.logger) as Partial<AgentReviewConfig['ai_review']>;
    }

    /**
     * 从 VSCode Settings 读取运行链路日志配置
     *
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
     * 加载流程：
     * 1. 获取默认配置作为基础
     * 2. 从YAML文件加载配置（如果存在）
     * 3. 从VSCode Settings加载AI配置（优先级最高）
     * 4. 合并所有配置（优先级：Settings > YAML > 默认）
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
                this.logger.info('YAML配置文件加载成功');
            } else {
                this.logger.info('YAML配置文件不存在，跳过');
            }

            if (!yamlConfig.ai_review && this.extensionPath) {
                const pluginYaml = await loadPluginYaml(this.extensionPath);
                if (pluginYaml?.ai_review) {
                    yamlConfig = { ...yamlConfig, ai_review: pluginYaml.ai_review };
                    this.logger.info('已从扩展目录加载 AI 配置（插件侧默认）');
                }
            }

            // 步骤3：从VSCode Settings读取AI配置（优先级最高）
            const settingsAIConfig = this.loadAIConfigFromSettings();
            if (settingsAIConfig) {
                this.logger.info('从VSCode Settings加载AI配置');
                // 将Settings配置合并到YAML配置中（Settings优先）
                // 确保必需的字段存在，使用默认值
                // 定义默认配置类型，确保必需字段有值
                const defaultAIConfig = {
                    enabled: false as boolean,
                    api_endpoint: '' as string,
                    timeout: 30000 as number,
                    action: 'warning' as const
                };
                
                // 获取现有的YAML配置或使用默认值
                const existingAIConfig = yamlConfig.ai_review || null;
                
                // 合并配置，确保必需字段有值
                // Settings配置优先，然后是YAML配置，最后是默认值
                // 注意：对于 enabled，如果 Settings 中未设置（undefined），应该使用 YAML 配置的值，而不是默认值 false
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
                // 使用类型断言，因为我们已经确保了所有必需字段都有值
                const mergedAIConfig: AgentReviewConfig['ai_review'] = {
                    // 必需字段（已确保有值）
                    enabled: enabledValue,
                    api_endpoint: apiEndpointValue,
                    timeout: timeoutValue,
                    action: actionValue,
                    // 可选字段：从Settings或YAML配置中获取
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
                this.logger.info('从VSCode Settings加载运行日志配置');
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

            // 步骤4：合并默认配置和用户配置（合并顺序：Settings > YAML > 默认）
            const resolvedUserConfig = resolveEnvInConfig(yamlConfig, this.envVars, this.logger) as Partial<AgentReviewConfig>;
            this.config = mergeConfigFn(defaultConfig, resolvedUserConfig, (s) =>
                resolveEnvVariables(s, this.envVars, this.logger)
            );

            // 自动默认：如果项目本身已存在 ESLint/TS/Prettier 规范，且用户未显式配置内置规则开关，则默认开启内置规则
            const hasUserBuiltinRulesSetting = !!(
                resolvedUserConfig.rules
                && Object.prototype.hasOwnProperty.call(resolvedUserConfig.rules, 'builtin_rules_enabled')
            );
            if (!hasUserBuiltinRulesSetting && this.detectProjectRuleConfig()) {
                this.config.rules.builtin_rules_enabled = true;
                this.logger.info('检测到项目已有规范配置，默认开启内置规则审查');
            }
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
     * 加载.env文件
     * 
     * 从所有工作区根目录的 .env 中读取环境变量并合并（先加载的优先，不覆盖已有键）。
     * 多根工作区时可在任意一个根目录放置 .env，避免“当前项目”下没有 .env 导致占位符未解析。
     * 支持标准 .env 格式：KEY=value、KEY="value"、# 注释、空行忽略。
     * 不覆盖系统环境变量（process.env）。
     */
    /** 解析 .env 文件内容并合并到 envVars（不覆盖已有键、不覆盖 process.env） */
    private parseAndMergeEnvContent(content: string, envPath: string, logPrefix = '从.env文件'): void {
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
                    this.logger.debug(`${logPrefix}加载环境变量: ${key} (${envPath})`);
                }
            } else {
                this.logger.warn(`.env文件第${lineNumber}行格式不正确，已跳过: ${trimmedLine}`);
            }
        }
    }

    private async loadEnvFile(): Promise<void> {
        this.envVars.clear();
        const folders = vscode.workspace.workspaceFolders ?? [];
        const envPaths = folders.length > 0 ? folders.map(f => path.join(f.uri.fsPath, '.env')) : [this.envPath || '.env'];
        this.logger.info(`加载.env文件: ${envPaths.join(', ')}`);
        try {
            for (const envPath of envPaths) {
                if (!fs.existsSync(envPath)) {
                    this.logger.debug(`.env文件不存在，跳过: ${envPath}`);
                    continue;
                }
                const content = await fs.promises.readFile(envPath, 'utf-8');
                this.parseAndMergeEnvContent(content, envPath);
            }
            if (this.envVars.size === 0 && this.extensionPath) {
                const fallbackEnv = path.join(this.extensionPath, '.env');
                if (fs.existsSync(fallbackEnv)) {
                    this.logger.info(`工作区未找到.env，从扩展目录加载: ${fallbackEnv}`);
                    const content = await fs.promises.readFile(fallbackEnv, 'utf-8');
                    this.parseAndMergeEnvContent(content, fallbackEnv, '从扩展目录.env');
                }
            }
            this.logger.info(`从.env文件加载了 ${this.envVars.size} 个环境变量`);
        } catch (error) {
            this.logger.error('加载.env文件失败', error);
        }
    }

    /**
     * 对对象进行稳定序列化，避免因键顺序变化导致误判
     * 
     * @param value - 需要序列化的对象
     * @returns 稳定排序后的 JSON 字符串
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
     * 检测项目是否已经存在外部工程规范配置（ESLint / TS / Prettier）。
     *
     * 用途：
     * - 当用户未显式设置 builtin_rules_enabled 时，如果探测到项目规则文件，则默认开启规则审查。
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
     * 获取项目约定摘要（自然语言），供 AI System Prompt 注入。
     * 根据根目录与 .eslintrc.json / .prettierrc.json / tsconfig.json 的 mtime 缓存。
     */
    async getProjectRulesSummary(): Promise<string> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const root = workspaceFolder?.uri.fsPath ?? '';
        if (!root) return '';
        let mtime = 0;
        const keyFiles = ['.eslintrc.json', 'eslint.config.json', '.prettierrc.json', 'tsconfig.json'];
        for (const name of keyFiles) {
            const p = path.join(root, name);
            try {
                if (fs.existsSync(p)) {
                    const stat = await fs.promises.stat(p);
                    if (stat.mtimeMs > mtime) mtime = stat.mtimeMs;
                }
            } catch {
                // 忽略单文件 stat 失败
            }
        }
        const cached = this.projectRulesSummaryCache;
        if (cached && cached.root === root && cached.mtime === mtime) {
            return cached.summary;
        }
        const summary = await getProjectRulesSummaryImpl(root);
        this.projectRulesSummaryCache = { root, mtime, summary };
        return summary;
    }

    /**
     * 获取默认配置
     * 
     * 这是插件的默认配置，当用户没有配置文件或配置项缺失时使用
     * 
     * 默认规则：
     * - naming_convention: 启用，阻止提交，检查文件名空格
     * - code_quality: 启用，警告级别，检查 TODO 注释
     * - git_hooks: 自动安装，启用 pre-commit 规则审查
     * 
     * @returns 默认配置对象
     */
    private getDefaultConfig(): AgentReviewConfig {
        return {
            version: '1.0',
            rules: {
                enabled: true,
                strict_mode: false,
                builtin_rules_enabled: false,  // 默认值为 false；若探测到项目规则文件且未显式配置，会自动开启
                diff_only: true,               // 默认仅扫描变更行
                naming_convention: {
                    enabled: true,
                    action: 'block_commit',
                    no_space_in_filename: true,
                },
                code_quality: {
                    enabled: true,
                    action: 'warning',
                    no_todo: true,
                },
            },
            ast: {
                enabled: true,
                max_node_lines: 200,
                max_file_lines: 2000,
                include_lsp_context: true, // 默认启用：为 AST 片段补充一层外部定义上下文
                preview_only: false,  // 默认 false：正常请求大模型；true 时仅打印切片不请求
            },
            git_hooks: {
                auto_install: true,
                pre_commit_enabled: true,
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
        // TODO: 保存配置到文件
        this.logger.info('保存配置文件');
    }

    /**
     * 清理资源
     * 当插件停用时调用，释放文件监听器等资源
     */
    dispose(): void {
        this.watcherDisposable?.dispose();
        this.watcherDisposable = undefined;
        this.envVars.clear();
        this.logger.info('配置管理器资源已清理');
    }
}
