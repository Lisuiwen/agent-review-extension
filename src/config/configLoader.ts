/**
 * 配置加载（仅读 YAML，不合并、不解析环境变量）
 *
 * 供 ConfigManager 在 loadConfig 中调用。
 */

import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import type { AgentReviewConfig } from '../types/config';

/**
 * 从给定路径读取 YAML 配置
 */
export const loadYamlFromPath = async (configPath: string): Promise<Partial<AgentReviewConfig>> => {
    if (!fs.existsSync(configPath)) {
        return {};
    }
    const fileContent = await fs.promises.readFile(configPath, 'utf-8');
    return (yaml.load(fileContent) as Partial<AgentReviewConfig>) || {};
};

/**
 * 从扩展目录读取插件侧 .agentreview.yaml（仅 ai_review 等）
 */
export const loadPluginYaml = async (extensionPath: string): Promise<Partial<AgentReviewConfig> | null> => {
    const pluginConfigPath = path.join(extensionPath, '.agentreview.yaml');
    if (!fs.existsSync(pluginConfigPath)) {
        return null;
    }
    try {
        const pluginContent = await fs.promises.readFile(pluginConfigPath, 'utf-8');
        const pluginYaml = yaml.load(pluginContent) as Partial<AgentReviewConfig>;
        return pluginYaml?.ai_review ? { ai_review: pluginYaml.ai_review } : null;
    } catch {
        return null;
    }
};
