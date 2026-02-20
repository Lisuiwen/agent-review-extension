/**
 * 
 * 杩欎釜鏂囦欢璐熻矗璇诲彇鍜岀鐞嗘彃浠剁殑閰嶇疆鏂囦欢
 * 
 * 4. 鎻愪緵閰嶇疆璁块棶鎺ュ彛
 * 
 * - 椤圭洰鏍圭洰褰曪細.agentreview.yaml
 * 
 * ```yaml
 * version: "1.0"
 * rules:
 *   enabled: true
 *   strict_mode: false
 *   builtin_rules_enabled: false  # 鏄惁鍚敤鍐呯疆瑙勫垯寮曟搸锛堣嫢妫€娴嬪埌椤圭洰瑙勫垯鏂囦欢涓旀湭鏄惧紡閰嶇疆锛屼細鑷姩寮€鍚級
 *   naming_convention:
 *     enabled: true
 *     action: "block_commit"
 *     no_space_in_filename: true
 *   code_quality:
 *     enabled: true
 *     action: "warning"
 *     no_todo: true
 *     no_todo_pattern: "(TODO|FIXME|XXX)"  # 鍙€夛細鑷畾涔夋鍒欒〃杈惧紡妯″紡
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

export type { AgentReviewConfig, RuleConfig } from '../types/config';

/**
 * 閰嶇疆绠＄悊鍣ㄧ被
 * 
 * ```typescript
 * const configManager = new ConfigManager();
 * await configManager.initialize();
 * const config = configManager.getConfig();
 * ```
 */
export class ConfigManager implements vscode.Disposable {
    private logger: Logger;                    // 日志记录?
    private config: AgentReviewConfig | null = null;  // 缓存的配?
    private configPath: string;                // 配置文件的完整路?
    private envPath: string;                   // .env文件的完整路?
    private extensionPath: string | undefined;  // 扩展安盽（用于单工作区时回加载 .env?
    private envVars: Map<string, string> = new Map();  // ?env文件加载的环境变?
    private watcherDisposable: ReturnType<typeof setupConfigWatcher> | undefined;  // 配置?.env 监听（含防抖?

    /**
     * 鍒濆鍖栭厤缃鐞嗗櫒锛岀‘瀹氶厤缃枃浠剁殑浣嶇疆
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
     * 鍒濆鍖栭厤缃鐞嗗櫒
     * @param context - 鎵╁睍涓婁笅鏂囷紝浼犲叆鏃剁敤浜庡崟宸ヤ綔鍖轰笅浠庢墿灞曠洰褰曞洖閫€鍔犺浇 .env
     */
    async initialize(context?: vscode.ExtensionContext): Promise<void> {
        this.extensionPath = context?.extensionPath;
        await this.loadEnvFile();
        // 鐒跺悗鍔犺浇閰嶇疆鏂囦欢
        await this.loadConfig();
        this.setupFileWatcher();
    }

    /**
     * 褰撻厤缃枃浠舵垨.env鏂囦欢鍙樻洿鏃讹紝鑷姩閲嶆柊鍔犺浇閰嶇疆
     */
    private setupFileWatcher(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.logger.warn('鏈壘鍒板伐浣滃尯锛屾棤娉曡缃厤缃枃浠剁洃鍚櫒');
            return;
        }
        const onReload = async () => {
            this.logger.info('测到配置?.env 变更，重新加载配?');
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
        this.logger.info('配置文件监听器已设置（包?env文件监听?');
    }

    /**
     * 閲嶆柊鍔犺浇閰嶇疆鏂囦欢
     * - 浼氫繚鐣欐棫閰嶇疆锛屽鏋滄柊閰嶇疆鍔犺浇澶辫触锛岀户缁娇鐢ㄦ棫閰嶇疆
     */
    private async reloadConfig(): Promise<void> {
        const oldConfig = this.config;
        
        try {
            const fileExists = fs.existsSync(this.configPath);
            
            // 灏濊瘯閲嶆柊鍔犺浇閰嶇疆
            const newConfig = await this.loadConfig();
            
            // 濡傛灉鏂囦欢瀛樺湪浣嗗姞杞藉悗閰嶇疆涓庨粯璁ら厤缃浉鍚岋紝鍙兘鏄姞杞藉け璐ヤ簡
            if (fileExists && oldConfig) {
                const defaultConfig = this.getDefaultConfig();
                // 绠€鍗曟鏌ワ細濡傛灉鏂伴厤缃笌榛樿閰嶇疆瀹屽叏鐩稿悓锛屽彲鑳芥槸鍔犺浇澶辫触
                // 杩欓噷浣跨敤 JSON 瀛楃涓叉瘮杈冿紝铏界劧涓嶅绮剧‘锛屼絾瀵逛簬 MVP 瓒冲
                const newConfigStr = this.stableStringify(newConfig);
                const defaultConfigStr = this.stableStringify(defaultConfig);
                const oldConfigStr = this.stableStringify(oldConfig);
                
                if (newConfigStr === defaultConfigStr && oldConfigStr !== defaultConfigStr) {
                    this.config = oldConfig;
                    this.logger.warn('閰嶇疆鏂囦欢鍙兘鍔犺浇澶辫触锛屼繚鎸佷娇鐢ㄦ棫閰嶇疆');
                    vscode.window.showWarningMessage(
                        '⚠️ AgentReview 配置加载參失败，已恢使用旧配罂查配罖件格式?'
                    );
                    return;
                }
            }
            
            // 鍔犺浇鎴愬姛锛屾樉绀洪€氱煡
            this.logger.info('閰嶇疆鏂囦欢閲嶆柊鍔犺浇鎴愬姛');
            vscode.window.showInformationMessage('?AgentReview 配置已更?');
        } catch (error) {
            // 鍔犺浇澶辫触锛屾仮澶嶆棫閰嶇疆
            this.logger.error('閰嶇疆鏂囦欢閲嶆柊鍔犺浇澶辫触锛屼繚鎸佷娇鐢ㄦ棫閰嶇疆', error);
            if (oldConfig) {
                this.config = oldConfig;
                vscode.window.showWarningMessage(
                    '⚠️ AgentReview 配置加载失败，已恢使用旧配罂查配罖件格式?'
                );
            } else {
                // 濡傛灉娌℃湁鏃ч厤缃紝浣跨敤榛樿閰嶇疆
                this.config = this.getDefaultConfig();
                vscode.window.showWarningMessage(
                    '⚠️ AgentReview 配置加载失败，已使用默配置。查配罖件格式?'
                );
            }
        }
    }

    /**
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
     *
     * 浼樺厛绾э細Settings > YAML > 榛樿
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
     * 鍔犺浇閰嶇疆鏂囦欢
     * 
     * 1. 鑾峰彇榛樿閰嶇疆浣滀负鍩虹
     * 2. 浠嶻AML鏂囦欢鍔犺浇閰嶇疆锛堝鏋滃瓨鍦級
     * 3. 浠嶸SCode Settings鍔犺浇AI閰嶇疆锛堜紭鍏堢骇鏈€楂橈級
     * 
     * @returns 鍔犺浇鍚庣殑閰嶇疆瀵硅薄
     */
    async loadConfig(): Promise<AgentReviewConfig> {
        this.logger.info(`鍔犺浇閰嶇疆鏂囦欢: ${this.configPath}`);
        // 姣忔鍔犺浇閰嶇疆鍓嶅厛閲嶆柊鍔犺浇 .env锛屼互渚夸娇鐢ㄦ渶鏂扮殑鐜鍙橀噺锛堝惈浠呯敤 .env 閰嶇疆绔偣鐨勬儏鍐碉級
        await this.loadEnvFile();
        // 鑾峰彇榛樿閰嶇疆浣滀负鍩虹
        const defaultConfig = this.getDefaultConfig();
        
        try {
            let yamlConfig = await loadYamlFromPath(this.configPath);
            if (Object.keys(yamlConfig).length > 0) {
                this.logger.info('YAML閰嶇疆鏂囦欢鍔犺浇鎴愬姛');
            } else {
                this.logger.info('YAML閰嶇疆鏂囦欢涓嶅瓨鍦紝璺宠繃');
            }

            if (!yamlConfig.ai_review && this.extensionPath) {
                const pluginYaml = await loadPluginYaml(this.extensionPath);
                if (pluginYaml?.ai_review) {
                    yamlConfig = { ...yamlConfig, ai_review: pluginYaml.ai_review };
                    this.logger.info('已从扩展盽加载 AI 配置（插件侧默?');
                }
            }

            // 姝ラ3锛氫粠VSCode Settings璇诲彇AI閰嶇疆锛堜紭鍏堢骇鏈€楂橈級
            const settingsAIConfig = this.loadAIConfigFromSettings();
            if (settingsAIConfig) {
                this.logger.info('浠嶸SCode Settings鍔犺浇AI閰嶇疆');
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
                // 鑻ユ湭閰嶇疆绔偣锛屽皾璇曚娇鐢ㄧ幆澧冨彉閲忓崰浣嶇锛屼究浜庝粠 .env 瑙ｆ瀽
                const apiEndpointValue = (settingsAIConfig.api_endpoint ?? existingAIConfig?.api_endpoint ?? defaultAIConfig.api_endpoint)
                    || '${AGENTREVIEW_AI_API_ENDPOINT}';
                const timeoutValue = settingsAIConfig.timeout !== undefined 
                    ? settingsAIConfig.timeout 
                    : (existingAIConfig?.timeout ?? defaultAIConfig.timeout);
                const actionValue = settingsAIConfig.action || existingAIConfig?.action || defaultAIConfig.action;
                
                // 鏋勫缓鍚堝苟鍚庣殑閰嶇疆瀵硅薄
                const mergedAIConfig: AgentReviewConfig['ai_review'] = {
                    // 蹇呴渶瀛楁锛堝凡纭繚鏈夊€硷級
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
                        ?? 800,
                    run_on_save_max_runs_per_minute:
                        settingsAIConfig.run_on_save_max_runs_per_minute
                        ?? existingAIConfig?.run_on_save_max_runs_per_minute
                        ?? 6,
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
                this.logger.info('浠嶸SCode Settings鍔犺浇杩愯鏃ュ織閰嶇疆');
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

            this.logger.info('閰嶇疆鏂囦欢鍔犺浇鎴愬姛');
            
            return this.config;
        } catch (error) {
            // 姝ラ5锛氬鏋滃嚭閿欙紙鏂囦欢鏍煎紡閿欒銆佹潈闄愰棶棰樼瓑锛夛紝浣跨敤榛樿閰嶇疆
            this.logger.error('鍔犺浇閰嶇疆鏂囦欢澶辫触', error);
            this.logger.warn('浣跨敤榛樿閰嶇疆');
            this.config = defaultConfig;
            return this.config;
        }
    }

    /**
     * 鍔犺浇 .env 鏂囦欢锛氫粠宸ヤ綔鍖烘牴鐩綍锛堝強澶氭牴鏃跺悇鏍癸級璇诲彇骞跺悎骞剁幆澧冨彉閲忥紱
     */
    private parseAndMergeEnvContent(content: string, envPath: string, logPrefix = '?env文件'): void {
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
                    this.logger.debug(`${logPrefix}鍔犺浇鐜鍙橀噺: ${key} (${envPath})`);
                }
            } else {
                this.logger.warn(`.env文件?{lineNumber}行格式不正确，已跳过: ${trimmedLine}`);
            }
        }
    }

    private async loadEnvFile(): Promise<void> {
        this.envVars.clear();
        const folders = vscode.workspace.workspaceFolders ?? [];
        const envPaths = folders.length > 0 ? folders.map(f => path.join(f.uri.fsPath, '.env')) : [this.envPath || '.env'];
        this.logger.info(`鍔犺浇.env鏂囦欢: ${envPaths.join(', ')}`);
        try {
            for (const envPath of envPaths) {
                if (!fs.existsSync(envPath)) {
                    this.logger.debug(`.env鏂囦欢涓嶅瓨鍦紝璺宠繃: ${envPath}`);
                    continue;
                }
                const content = await fs.promises.readFile(envPath, 'utf-8');
                this.parseAndMergeEnvContent(content, envPath);
            }
            if (this.envVars.size === 0 && this.extensionPath) {
                const fallbackEnv = path.join(this.extensionPath, '.env');
                if (fs.existsSync(fallbackEnv)) {
                    this.logger.info(`宸ヤ綔鍖烘湭鎵惧埌.env锛屼粠鎵╁睍鐩綍鍔犺浇: ${fallbackEnv}`);
                    const content = await fs.promises.readFile(fallbackEnv, 'utf-8');
                    this.parseAndMergeEnvContent(content, fallbackEnv, '从扩展目?env');
                }
            }
            this.logger.info(`从 .env 文件加载了 ${this.envVars.size} 个环境变量`);
        } catch (error) {
            this.logger.error('鍔犺浇.env鏂囦欢澶辫触', error);
        }
    }

    /**
     * 
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
     * 鐢ㄩ€旓細
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
     * 鑾峰彇褰撳墠閰嶇疆
     * 濡傛灉閰嶇疆鏈姞杞斤紝杩斿洖榛樿閰嶇疆
     * 
     * @returns 閰嶇疆瀵硅薄
     */
    getConfig(): AgentReviewConfig {
        return this.config || this.getDefaultConfig();
    }

    /**
     */
    getRuleSource(): 'project' | 'builtin' {
        return this.detectProjectRuleConfig() ? 'project' : 'builtin';
    }

    /**
     * 鑾峰彇榛樿閰嶇疆
     * 
     * 杩欐槸鎻掍欢鐨勯粯璁ら厤缃紝褰撶敤鎴锋病鏈夐厤缃枃浠舵垨閰嶇疆椤圭己澶辨椂浣跨敤
     * 
     * - naming_convention: 鍚敤锛岄樆姝㈡彁浜わ紝妫€鏌ユ枃浠跺悕绌烘牸
     * 
     * @returns 榛樿閰嶇疆瀵硅薄
     */
    private getDefaultConfig(): AgentReviewConfig {
        return {
            version: '1.0',
            rules: {
                enabled: true,
                strict_mode: false,
                builtin_rules_enabled: false,  // 默值为 false；若探测到项则文件且朘式配罼会自动开?
                diff_only: true,               // 榛樿浠呮壂鎻忓彉鏇磋
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
                include_lsp_context: true, // 榛樿鍚敤锛氫负 AST 鐗囨琛ュ厖涓€灞傚閮ㄥ畾涔変笂涓嬫枃
                preview_only: false,  // 默 false：常求大模型；true 时仅打印切片不?
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
        this.logger.info('淇濆瓨閰嶇疆鏂囦欢');
    }

    /**
     * 娓呯悊璧勬簮
     */
    dispose(): void {
        this.watcherDisposable?.dispose();
        this.watcherDisposable = undefined;
        this.envVars.clear();
        this.logger.info('閰嶇疆绠＄悊鍣ㄨ祫婧愬凡娓呯悊');
    }
}
