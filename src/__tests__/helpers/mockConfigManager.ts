/**
 * ConfigManager Mock 工具
 * 
 * 提供可配置的 ConfigManager mock，用于测试中快速创建配置管理器实例
 */

import { ConfigManager, AgentReviewConfig } from '../../config/configManager';
import { createDefaultConfig } from './testFixtures';

/**
 * Mock ConfigManager 类
 * 用于测试中快速创建配置管理器，无需实际读取文件
 */
export class MockConfigManager extends ConfigManager {
    private mockConfig: AgentReviewConfig;

    constructor(config?: Partial<AgentReviewConfig>) {
        // 调用父类构造函数，但不会实际初始化
        super();
        this.mockConfig = { ...createDefaultConfig(), ...config };
    }

    /**
     * 重写 getConfig 方法，返回 mock 配置
     */
    getConfig(): AgentReviewConfig {
        return this.mockConfig;
    }

    /**
     * 设置配置
     */
    setConfig(config: Partial<AgentReviewConfig>): void {
        this.mockConfig = { ...this.mockConfig, ...config };
    }

    /**
     * 更新配置的特定部分
     */
    updateConfig(updates: Partial<AgentReviewConfig>): void {
        this.mockConfig = {
            ...this.mockConfig,
            ...updates,
            rules: {
                ...this.mockConfig.rules,
                ...(updates.rules || {}),
            },
        };
    }

    /**
     * 初始化方法（mock 版本，不执行实际初始化）
     */
    async initialize(): Promise<void> {
        // Mock 版本不需要实际初始化
    }

    /**
     * Dispose 方法（mock 版本）
     */
    dispose(): void {
        // Mock 版本不需要实际清理
    }
}

/**
 * 创建 Mock ConfigManager 的工厂函数
 */
export const createMockConfigManager = (config?: Partial<AgentReviewConfig>): MockConfigManager => {
    return new MockConfigManager(config);
};
