/**
 * 独立配置加载（无 VSCode 依赖）
 *
 * 给定 workspaceRoot 读取 .agentreview.yaml 并合并默认配置，供 hookRunner 使用。
 */

import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import type { AgentReviewConfig } from '../types/config';

const getDefaultConfig = (): AgentReviewConfig => ({
    version: '1.0',
    rules: {
        enabled: true,
        strict_mode: false,
        builtin_rules_enabled: true,
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
        auto_install: false,
        pre_commit_enabled: true,
        allow_commit_once: true,
    },
    exclusions: undefined,
});

/**
 * 从工作区根目录加载配置（仅 YAML + 默认，不处理 .env）
 */
export const loadStandaloneConfig = async (workspaceRoot: string): Promise<AgentReviewConfig> => {
    const configPath = path.join(workspaceRoot, '.agentreview.yaml');
    const defaultConfig = getDefaultConfig();

    if (!fs.existsSync(configPath)) {
        return defaultConfig;
    }

    try {
        const fileContent = await fs.promises.readFile(configPath, 'utf-8');
        const userConfig = yaml.load(fileContent) as Partial<AgentReviewConfig>;
        return { ...defaultConfig, ...userConfig } as AgentReviewConfig;
    } catch (error) {
        console.error(`[WARN] 加载配置文件失败，使用默认配置: ${error}`);
        return defaultConfig;
    }
};
