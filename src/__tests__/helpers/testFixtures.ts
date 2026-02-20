/**
 * 测试数据工厂
 * 
 * 提供各种测试数据的工厂函数，用于创建测试所需的配置、文件内容等
 */

import { AgentReviewConfig } from '../../config/configManager';

/**
 * 创建默认配置
 */
export const createDefaultConfig = (): AgentReviewConfig => ({
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
            action: 'block_commit',
            no_todo: true,
            no_debugger: true,
        },
    },
});

/**
 * 创建包含命名规范规则的配置
 */
export const createNamingConventionConfig = (action: 'block_commit' | 'warning' | 'log' = 'block_commit'): AgentReviewConfig => ({
    ...createDefaultConfig(),
    rules: {
        ...createDefaultConfig().rules,
        naming_convention: {
            enabled: true,
            action,
            no_space_in_filename: true,
        },
    },
});

/**
 * 创建包含代码质量规则的配置
 */
export const createCodeQualityConfig = (action: 'block_commit' | 'warning' | 'log' = 'block_commit'): AgentReviewConfig => ({
    ...createDefaultConfig(),
    rules: {
        ...createDefaultConfig().rules,
        code_quality: {
            enabled: true,
            action,
            no_todo: true,
            no_debugger: true,
        },
    },
});

/**
 * 创建严格模式配置
 */
export const createStrictModeConfig = (): AgentReviewConfig => ({
    ...createDefaultConfig(),
    rules: {
        ...createDefaultConfig().rules,
        strict_mode: true,
    },
});

/**
 * 创建禁用规则的配置
 */
export const createDisabledRulesConfig = (): AgentReviewConfig => ({
    ...createDefaultConfig(),
    rules: {
        ...createDefaultConfig().rules,
        enabled: false,
    },
});

/**
 * 创建包含排除规则的配置
 */
export const createExclusionsConfig = (files?: string[], directories?: string[]): AgentReviewConfig => ({
    ...createDefaultConfig(),
    exclusions: {
        files,
        directories,
    },
});

/**
 * 创建包含 AI 审查的配置
 */
export const createAIReviewConfig = (enabled: boolean = true): AgentReviewConfig => ({
    ...createDefaultConfig(),
    ai_review: {
        enabled,
        api_format: 'openai',
        api_endpoint: 'https://api.openai.com/v1/chat/completions',
        api_key: 'test-api-key',
        model: 'test-model',
        timeout: 30000,
        action: 'warning',
    },
});

/**
 * 创建测试文件内容
 */
export const createTestFileContent = {
    /**
     * 创建包含 TODO 的文件内容
     */
    withTodo: (): string => {
        return `function test() {
    // TODO: 需要实现这个功能
    console.log('test');
    
    // FIXME: 这里有bug
    const x = 1;
    
    // XXX: 临时方案
    return x;
}`;
    },

    /**
     * 创建干净的文件内容（无问题）
     */
    clean: (): string => {
        return `export function clean() {
    return 'clean code';
}`;
    },

    /**
     * 创建包含多个 TODO 的文件内容
     */
    withMultipleTodos: (): string => {
        return `// TODO: 第一个TODO
function func1() {
    return 1;
}

// FIXME: 第二个FIXME
function func2() {
    return 2;
}

// XXX: 第三个XXX
function func3() {
    return 3;
}`;
    },
};

/**
 * 创建 YAML 配置字符串
 */
export const createYamlConfig = (config: Partial<AgentReviewConfig>): string => {
    const fullConfig = { ...createDefaultConfig(), ...config };
    return `version: "${fullConfig.version}"
rules:
  enabled: ${fullConfig.rules.enabled}
  strict_mode: ${fullConfig.rules.strict_mode}
  naming_convention:
    enabled: ${fullConfig.rules.naming_convention?.enabled ?? true}
    action: "${fullConfig.rules.naming_convention?.action ?? 'block_commit'}"
    no_space_in_filename: ${fullConfig.rules.naming_convention?.no_space_in_filename ?? true}
  code_quality:
    enabled: ${fullConfig.rules.code_quality?.enabled ?? true}
    action: "${fullConfig.rules.code_quality?.action ?? 'block_commit'}"
    no_todo: ${fullConfig.rules.code_quality?.no_todo ?? true}
    no_debugger: ${fullConfig.rules.code_quality?.no_debugger ?? true}
${fullConfig.exclusions ? `exclusions:
  files: ${JSON.stringify(fullConfig.exclusions.files || [])}
  directories: ${JSON.stringify(fullConfig.exclusions.directories || [])}` : ''}`;
};
