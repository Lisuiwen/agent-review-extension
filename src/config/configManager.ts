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
 *   naming_convention:
 *     enabled: true
 *     action: "block_commit"
 *     no_space_in_filename: true
 *   code_quality:
 *     enabled: true
 *     action: "warning"
 *     no_todo: true
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
        code_quality?: RuleConfig;
        security?: RuleConfig;
        naming_convention?: RuleConfig;
        business_logic?: RuleConfig;
    };
    ai_review?: {
        enabled: boolean;
        api_endpoint: string;
        api_key?: string;
        timeout: number;
        action: 'block_commit' | 'warning' | 'log';
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
    private configWatcher: vscode.FileSystemWatcher | undefined;  // 配置文件监听器
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
    }

    /**
     * 初始化配置管理器
     * 在插件激活时调用，加载配置文件并设置文件监听器
     */
    async initialize(): Promise<void> {
        await this.loadConfig();
        this.setupFileWatcher();
    }

    /**
     * 设置配置文件监听器
     * 当配置文件变更时，自动重新加载配置
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

        // 监听文件变更事件
        // 使用防抖机制，避免保存文件时触发多次事件导致频繁重载
        this.configWatcher.onDidChange(async () => {
            // 清除之前的定时器
            if (this.reloadTimer) {
                clearTimeout(this.reloadTimer);
            }

            // 设置防抖定时器，300ms 后执行重载
            // 这样可以避免文件保存时触发多次事件
            this.reloadTimer = setTimeout(async () => {
                this.logger.info('检测到配置文件变更，重新加载配置');
                await this.reloadConfig();
            }, 300);
        });

        // 监听文件创建事件（如果配置文件不存在，后来创建了）
        this.configWatcher.onDidCreate(async () => {
            if (this.reloadTimer) {
                clearTimeout(this.reloadTimer);
            }
            this.reloadTimer = setTimeout(async () => {
                this.logger.info('检测到配置文件创建，加载配置');
                await this.reloadConfig();
            }, 300);
        });

        // 监听文件删除事件（如果配置文件被删除，使用默认配置）
        this.configWatcher.onDidDelete(async () => {
            if (this.reloadTimer) {
                clearTimeout(this.reloadTimer);
            }
            this.reloadTimer = setTimeout(async () => {
                this.logger.info('检测到配置文件删除，使用默认配置');
                await this.reloadConfig();
            }, 300);
        });

        this.logger.info('配置文件监听器已设置');
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
                const newConfigStr = JSON.stringify(newConfig);
                const defaultConfigStr = JSON.stringify(defaultConfig);
                const oldConfigStr = JSON.stringify(oldConfig);
                
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
     * 加载配置文件
     * 
     * 加载流程：
     * 1. 检查配置文件是否存在
     * 2. 如果存在，读取并解析 YAML 文件
     * 3. 合并用户配置和默认配置（用户配置优先）
     * 4. 如果文件不存在或解析失败，使用默认配置
     * 
     * @returns 加载后的配置对象
     */
    async loadConfig(): Promise<AgentReviewConfig> {
        this.logger.info(`加载配置文件: ${this.configPath}`);
        
        // 获取默认配置作为基础
        const defaultConfig = this.getDefaultConfig();
        
        try {
            // 步骤1：检查配置文件是否存在
            if (!fs.existsSync(this.configPath)) {
                this.logger.info('配置文件不存在，使用默认配置');
                this.config = defaultConfig;
                return this.config;
            }

            // 步骤2：读取 YAML 文件内容
            // fs.promises.readFile 是 Node.js 的异步文件读取 API
            const fileContent = await fs.promises.readFile(this.configPath, 'utf-8');
            // yaml.load 是 js-yaml 库提供的函数，用于解析 YAML 字符串
            const userConfig = yaml.load(fileContent) as Partial<AgentReviewConfig>;

            // 步骤3：合并默认配置和用户配置
            // 用户配置会覆盖默认配置，未配置的项使用默认值
            this.config = this.mergeConfig(defaultConfig, userConfig);
            this.logger.info('配置文件加载成功');
            
            return this.config;
        } catch (error) {
            // 步骤4：如果出错（文件格式错误、权限问题等），使用默认配置
            this.logger.error('加载配置文件失败', error);
            this.logger.warn('使用默认配置');
            this.config = defaultConfig;
            return this.config;
        }
    }

    /**
     * 合并默认配置和用户配置
     * 
     * 合并策略：
     * - 顶层属性：用户配置覆盖默认配置
     * - 嵌套对象（如 rules.code_quality）：深度合并，用户配置优先
     * - 数组（如 exclusions.files）：用户配置完全替换默认配置
     * 
     * @param defaultConfig - 默认配置对象
     * @param userConfig - 用户配置对象（可能不完整）
     * @returns 合并后的完整配置对象
     */
    private mergeConfig(defaultConfig: AgentReviewConfig, userConfig: Partial<AgentReviewConfig>): AgentReviewConfig {
        const merged: AgentReviewConfig = {
            ...defaultConfig,
            ...userConfig,
            rules: {
                ...defaultConfig.rules,
                ...userConfig.rules,
                code_quality: userConfig.rules?.code_quality 
                    ? { ...defaultConfig.rules.code_quality, ...userConfig.rules.code_quality }
                    : defaultConfig.rules.code_quality,
                naming_convention: userConfig.rules?.naming_convention
                    ? { ...defaultConfig.rules.naming_convention, ...userConfig.rules.naming_convention }
                    : defaultConfig.rules.naming_convention,
                security: userConfig.rules?.security
                    ? { ...defaultConfig.rules.security, ...userConfig.rules.security }
                    : defaultConfig.rules.security,
                business_logic: userConfig.rules?.business_logic
                    ? { ...defaultConfig.rules.business_logic, ...userConfig.rules.business_logic }
                    : defaultConfig.rules.business_logic,
            },
            git_hooks: (() => {
                const defaultHooks: { auto_install: boolean; pre_commit_enabled: boolean } = 
                    defaultConfig.git_hooks || { auto_install: true, pre_commit_enabled: true };
                if (userConfig.git_hooks) {
                    return {
                        auto_install: userConfig.git_hooks.auto_install ?? defaultHooks.auto_install,
                        pre_commit_enabled: userConfig.git_hooks.pre_commit_enabled ?? defaultHooks.pre_commit_enabled,
                    } as { auto_install: boolean; pre_commit_enabled: boolean };
                }
                return defaultHooks;
            })(),
            exclusions: {
                files: userConfig.exclusions?.files || defaultConfig.exclusions?.files || [],
                directories: userConfig.exclusions?.directories || defaultConfig.exclusions?.directories || [],
            },
        };

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

        this.logger.info('配置管理器资源已清理');
    }
}
