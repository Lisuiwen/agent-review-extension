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
 *   builtin_rules_enabled: false  # 是否启用内置规则引擎（默认false，避免与项目自有规则冲突）
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
import * as yaml from 'js-yaml';
import { Logger } from '../utils/logger';

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
        action: 'block_commit' | 'warning' | 'log';  // 违反规则时的行为
    };
    ast?: {
        enabled?: boolean;          // 是否启用 AST 片段模式（默认 false）
        max_node_lines?: number;   // 单个 AST 节点的最大行数
        max_file_lines?: number;   // 文件总行数超过阈值则回退
        preview_only?: boolean;     // 为 true 时不调用大模型，仅打印将发送的 AST/变更切片内容
    };
    git_hooks?: {
        auto_install: boolean;
        pre_commit_enabled: boolean;
    };
    exclusions?: {
        files?: string[];
        directories?: string[];
    };
}

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
    private configWatcher: vscode.FileSystemWatcher | undefined;  // 配置文件监听器
    private envWatcher: vscode.FileSystemWatcher | undefined;    // .env文件监听器
    private reloadTimer: NodeJS.Timeout | undefined;  // 防抖定时器

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

        // 创建文件系统监听器，监听 .agentreview.yaml 文件
        // RelativePattern 用于指定相对于工作区根目录的文件模式
        this.configWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolder, '.agentreview.yaml')
        );

        // 创建.env文件监听器
        this.envWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolder, '.env')
        );

        // 定义重新加载函数（防抖处理）
        const scheduleReload = async (reason: string) => {
            if (this.reloadTimer) {
                clearTimeout(this.reloadTimer);
            }
            this.reloadTimer = setTimeout(async () => {
                this.logger.info(`检测到${reason}变更，重新加载配置`);
                // 先重新加载.env文件，然后重新加载配置
                await this.loadEnvFile();
                await this.reloadConfig();
            }, 300);
        };

        // 监听配置文件变更事件
        this.configWatcher.onDidChange(() => scheduleReload('配置文件'));
        this.configWatcher.onDidCreate(() => scheduleReload('配置文件创建'));
        this.configWatcher.onDidDelete(() => scheduleReload('配置文件删除'));

        // 监听.env文件变更事件
        this.envWatcher.onDidChange(() => scheduleReload('.env文件'));
        this.envWatcher.onDidCreate(() => scheduleReload('.env文件创建'));
        this.envWatcher.onDidDelete(() => scheduleReload('.env文件删除'));

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
     * 从VSCode Settings读取AI审查配置
     * 
     * 优先级：Settings > YAML > 默认
     * 
     * @returns AI审查配置对象（如果Settings中有配置）
     */
    private loadAIConfigFromSettings(): Partial<AgentReviewConfig['ai_review']> | undefined {
        const settings = vscode.workspace.getConfiguration('agentreview');
        const aiSettings = settings.get('ai');
        
        if (!aiSettings || typeof aiSettings !== 'object') {
            return undefined;
        }

        const aiConfig: any = {};
        
        // 读取所有AI相关配置项
        if (settings.get('ai.enabled') !== undefined) {
            aiConfig.enabled = settings.get('ai.enabled');
        }
        if (settings.get('ai.apiFormat')) {
            aiConfig.api_format = settings.get('ai.apiFormat');
        }
        if (settings.get('ai.apiEndpoint')) {
            aiConfig.api_endpoint = settings.get('ai.apiEndpoint');
        }
        if (settings.get('ai.apiKey')) {
            aiConfig.api_key = settings.get('ai.apiKey');
        }
        if (settings.get('ai.model')) {
            aiConfig.model = settings.get('ai.model');
        }
        if (settings.get('ai.timeout') !== undefined) {
            aiConfig.timeout = settings.get('ai.timeout');
        }
        if (settings.get('ai.temperature') !== undefined) {
            aiConfig.temperature = settings.get('ai.temperature');
        }
        if (settings.get('ai.maxTokens') !== undefined) {
            aiConfig.max_tokens = settings.get('ai.maxTokens');
        }
        if (settings.get('ai.systemPrompt')) {
            aiConfig.system_prompt = settings.get('ai.systemPrompt');
        }
        if (settings.get('ai.retryCount') !== undefined) {
            aiConfig.retry_count = settings.get('ai.retryCount');
        }
        if (settings.get('ai.retryDelay') !== undefined) {
            aiConfig.retry_delay = settings.get('ai.retryDelay');
        }
        if (settings.get('ai.action')) {
            aiConfig.action = settings.get('ai.action');
        }
        if (settings.get('ai.diffOnly') !== undefined) {
            aiConfig.diff_only = settings.get('ai.diffOnly');
        }

        // 如果没有任何配置，返回undefined
        if (Object.keys(aiConfig).length === 0) {
            return undefined;
        }

        // 解析环境变量
        return this.resolveEnvInConfig(aiConfig) as Partial<AgentReviewConfig['ai_review']>;
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
            let yamlConfig: Partial<AgentReviewConfig> = {};
            
            // 步骤1：检查配置文件是否存在，如果存在则读取
            if (fs.existsSync(this.configPath)) {
                const fileContent = await fs.promises.readFile(this.configPath, 'utf-8');
                yamlConfig = yaml.load(fileContent) as Partial<AgentReviewConfig>;
                this.logger.info('YAML配置文件加载成功');
            } else {
                this.logger.info('YAML配置文件不存在，跳过');
            }

            // 步骤2：若工作区未配置 ai_review，尝试从扩展目录读取（插件侧默认，对所有工作区生效）
            if (!yamlConfig.ai_review && this.extensionPath) {
                const pluginConfigPath = path.join(this.extensionPath, '.agentreview.yaml');
                if (fs.existsSync(pluginConfigPath)) {
                    try {
                        const pluginContent = await fs.promises.readFile(pluginConfigPath, 'utf-8');
                        const pluginYaml = yaml.load(pluginContent) as Partial<AgentReviewConfig>;
                        if (pluginYaml?.ai_review) {
                            yamlConfig.ai_review = pluginYaml.ai_review;
                            this.logger.info('已从扩展目录加载 AI 配置（插件侧默认）');
                        }
                    } catch (e) {
                        this.logger.debug('读取扩展目录 .agentreview.yaml 失败，跳过', e);
                    }
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
                };
                yamlConfig.ai_review = mergedAIConfig;
            }

            // 步骤4：合并默认配置和用户配置
            // 合并顺序：Settings（已在yamlConfig中）> YAML > 默认
            this.config = this.mergeConfig(defaultConfig, yamlConfig);
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
    private async loadEnvFile(): Promise<void> {
        this.envVars.clear();
        const folders = vscode.workspace.workspaceFolders ?? [];
        const envPaths = folders.length > 0
            ? folders.map(f => path.join(f.uri.fsPath, '.env'))
            : [this.envPath || '.env'];
        this.logger.info(`加载.env文件: ${envPaths.join(', ')}`);
        try {
            for (const envPath of envPaths) {
                if (!fs.existsSync(envPath)) {
                    this.logger.debug(`.env文件不存在，跳过: ${envPath}`);
                    continue;
                }
                const fileContent = await fs.promises.readFile(envPath, 'utf-8');
                const lines = fileContent.split(/\r?\n/);
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
                            this.logger.debug(`从.env文件加载环境变量: ${key} (${envPath})`);
                        }
                    } else {
                        this.logger.warn(`.env文件第${lineNumber}行格式不正确，已跳过: ${trimmedLine}`);
                    }
                }
            }
            // 单工作区且工作区内无 .env 时，回退到扩展目录的 .env（便于开发/调试时在扩展根目录放 .env）
            if (this.envVars.size === 0 && this.extensionPath) {
                const fallbackEnv = path.join(this.extensionPath, '.env');
                if (fs.existsSync(fallbackEnv)) {
                    this.logger.info(`工作区未找到.env，从扩展目录加载: ${fallbackEnv}`);
                    const fileContent = await fs.promises.readFile(fallbackEnv, 'utf-8');
                    const lines = fileContent.split(/\r?\n/);
                    for (const line of lines) {
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
                                this.logger.debug(`从扩展目录.env加载: ${key}`);
                            }
                        }
                    }
                }
            }
            this.logger.info(`从.env文件加载了 ${this.envVars.size} 个环境变量`);
        } catch (error) {
            this.logger.error('加载.env文件失败', error);
        }
    }

    /**
     * 解析环境变量
     * 
     * 支持 ${VAR_NAME} 格式的环境变量替换
     * 优先级：系统环境变量（process.env）> .env文件中的变量
     * 例如：${API_KEY} 会先查找 process.env.API_KEY，如果不存在，再查找 .env 文件中的值
     * 
     * @param value - 可能包含环境变量的字符串
     * @returns 解析后的字符串
     */
    private resolveEnvVariables(value: string): string {
        // 匹配 ${VAR_NAME} 格式
        const envVarPattern = /\$\{([^}]+)\}/g;
        
        return value.replace(envVarPattern, (match, varName) => {
            // 优先从系统环境变量获取（process.env优先级更高）
            let envValue = process.env[varName];
            const hasProcessEnv = envValue !== undefined;
            // 如果系统环境变量中不存在，从.env文件中获取
            if (envValue === undefined) {
                envValue = this.envVars.get(varName);
            }
            const hasEnvVars = this.envVars.has(varName);
            if (envValue !== undefined) {
                return envValue;
            }
            
            // 如果环境变量不存在，保持原样（不替换）
            this.logger.warn(`环境变量 ${varName} 未定义，保持原值: ${match}`);
            return match;
        });
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
     * 递归解析配置对象中的所有字符串值中的环境变量
     * 
     * @param obj - 配置对象（可能是嵌套对象）
     * @returns 解析后的配置对象
     */
    private resolveEnvInConfig(obj: any): any {
        if (typeof obj === 'string') {
            // 如果是字符串，解析环境变量
            return this.resolveEnvVariables(obj);
        } else if (Array.isArray(obj)) {
            // 如果是数组，递归处理每个元素
            return obj.map(item => this.resolveEnvInConfig(item));
        } else if (obj !== null && typeof obj === 'object') {
            // 如果是对象，递归处理每个属性
            const resolved: any = {};
            for (const key in obj) {
                resolved[key] = this.resolveEnvInConfig(obj[key]);
            }
            return resolved;
        }
        // 其他类型（number, boolean等）直接返回
        return obj;
    }

    /**
     * 合并默认配置和用户配置
     * 
     * 合并策略：
     * - 顶层属性：用户配置覆盖默认配置
     * - 嵌套对象（如 rules.code_quality）：深度合并，用户配置优先
     * - 数组（如 exclusions.files）：用户配置完全替换默认配置
     * - 自动解析环境变量（${VAR_NAME}格式）
     * 
     * @param defaultConfig - 默认配置对象
     * @param userConfig - 用户配置对象（可能不完整）
     * @returns 合并后的完整配置对象
     */
    private mergeConfig(defaultConfig: AgentReviewConfig, userConfig: Partial<AgentReviewConfig>): AgentReviewConfig {
        // 先解析用户配置中的环境变量
        const resolvedUserConfig = this.resolveEnvInConfig(userConfig) as Partial<AgentReviewConfig>;
        
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
                const defaultHooks: { auto_install: boolean; pre_commit_enabled: boolean } = 
                    defaultConfig.git_hooks || { auto_install: true, pre_commit_enabled: true };
                if (resolvedUserConfig.git_hooks) {
                    return {
                        auto_install: resolvedUserConfig.git_hooks.auto_install ?? defaultHooks.auto_install,
                        pre_commit_enabled: resolvedUserConfig.git_hooks.pre_commit_enabled ?? defaultHooks.pre_commit_enabled,
                    } as { auto_install: boolean; pre_commit_enabled: boolean };
                }
                return defaultHooks;
            })(),
            exclusions: {
                files: resolvedUserConfig.exclusions?.files || defaultConfig.exclusions?.files || [],
                directories: resolvedUserConfig.exclusions?.directories || defaultConfig.exclusions?.directories || [],
            },
            // ast 与 git_hooks 一样做逐项合并，保证 yaml 里只写 enabled/preview_only 时也能生效且不丢默认值
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
        };

        // 若仅通过 .env 配置 AI：端点和密钥、模型为空时，尝试从环境变量回退
        if (merged.ai_review) {
            if (!merged.ai_review.api_endpoint) {
                merged.ai_review.api_endpoint = this.resolveEnvVariables('${AGENTREVIEW_AI_API_ENDPOINT}');
            }
            if (!merged.ai_review.api_key) {
                merged.ai_review.api_key = this.resolveEnvVariables('${AGENTREVIEW_AI_API_KEY}');
            }
            const envModel = this.resolveEnvVariables('${AGENTREVIEW_AI_MODEL}');
            if (envModel && !envModel.includes('${') && (!merged.ai_review.model)) {
                merged.ai_review.model = envModel;
            }
        }

        return merged;
    }

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
     * 获取默认配置
     * 
     * 这是插件的默认配置，当用户没有配置文件或配置项缺失时使用
     * 
     * 默认规则：
     * - naming_convention: 启用，阻止提交，检查文件名空格
     * - code_quality: 启用，警告级别，检查 TODO 注释
     * - git_hooks: 自动安装，启用 pre-commit
     * 
     * @returns 默认配置对象
     */
    private getDefaultConfig(): AgentReviewConfig {
        return {
            version: '1.0',
            rules: {
                enabled: true,
                strict_mode: false,
                builtin_rules_enabled: false,  // 默认禁用内置规则引擎，避免与项目自有规则冲突
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
        // 清除防抖定时器
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
            this.reloadTimer = undefined;
        }

        // 释放文件监听器
        if (this.configWatcher) {
            this.configWatcher.dispose();
            this.configWatcher = undefined;
        }
        
        if (this.envWatcher) {
            this.envWatcher.dispose();
            this.envWatcher = undefined;
        }

        // 清空环境变量缓存
        this.envVars.clear();

        this.logger.info('配置管理器资源已清理');
    }
}
