import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
// import * as yaml from 'js-yaml'; // TODO: 需要时取消注释
import { Logger } from '../utils/logger';

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

export interface RuleConfig {
    enabled: boolean;
    action: 'block_commit' | 'warning' | 'log';
    [key: string]: any;
}

export class ConfigManager {
    private logger: Logger;
    private config: AgentReviewConfig | null = null;
    private configPath: string;

    constructor() {
        this.logger = new Logger('ConfigManager');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        this.configPath = workspaceFolder 
            ? path.join(workspaceFolder.uri.fsPath, '.agentreview.yaml')
            : '.agentreview.yaml';
    }

    async initialize(): Promise<void> {
        // TODO: 加载配置文件
        await this.loadConfig();
    }

    async loadConfig(): Promise<AgentReviewConfig> {
        // TODO: 从文件系统或工作区配置加载配置
        this.logger.info('加载配置文件');
        
        // TODO: 读取YAML文件
        // TODO: 合并VSCode设置
        // TODO: 验证配置格式

        return this.getDefaultConfig();
    }

    getConfig(): AgentReviewConfig {
        return this.config || this.getDefaultConfig();
    }

    private getDefaultConfig(): AgentReviewConfig {
        return {
            version: '1.0',
            rules: {
                enabled: true,
                strict_mode: false
            }
        };
    }

    async saveConfig(config: AgentReviewConfig): Promise<void> {
        // TODO: 保存配置到文件
        this.logger.info('保存配置文件');
    }
}
