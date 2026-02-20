/**
 * ConfigManager 单元测试
 *
 * 测试用例覆盖：
 * - 2.1: 默认配置加载
 * - 2.2: YAML 配置文件读取
 * - 2.3: 配置合并（部分配置）
 * - 2.4: 配置文件错误处理
 * - 2.5: 配置重载顺序稳定性（stableStringify）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../../config/configManager';
import { createTempFileSystem, TempFileSystem } from '../helpers/tempFileSystem';
import { createYamlConfig, createDefaultConfig } from '../helpers/testFixtures';
import * as vscode from 'vscode';

describe('ConfigManager', () => {
    let tempFs: TempFileSystem;
    let configManager: ConfigManager;

    beforeEach(async () => {
        // 单独创建临时文件系统
        tempFs = await createTempFileSystem();
        
        // 设置工作区路径（ConfigManager 需要工作区）
        (vscode.workspace as any).workspaceFolders = [{
            uri: { fsPath: tempFs.getTempDir() },
            name: 'test-workspace',
            index: 0,
        }];
        
        // 单独创建 ConfigManager 实例（每次测试都单独创建新的，确保使用正确的工作区路径）
        configManager = new ConfigManager();
    });

    afterEach(async () => {
        // 清理临时文件
        if (tempFs) {
            await tempFs.cleanup();
        }
        if (configManager) {
            configManager.dispose();
        }
    });

    describe('测试用例 2.1: 默认配置加载', () => {
        it('应在没有配置文件时使用默认配置', async () => {
            // 不创建配罖件，直接初?
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 验证默配置的基朻?
            expect(config).toBeDefined();
            expect(config.version).toBe('1.0');
            expect(config.rules.enabled).toBe(true);
            expect(config.rules.strict_mode).toBe(false);
            expect(config.rules.naming_convention?.enabled).toBe(true);
            expect(config.rules.code_quality?.enabled).toBe(true);
        });

        it('默配置应包含有必的?', async () => {
            await configManager.initialize();
            const config = configManager.getConfig();
            
            // 楠岃瘉鍛藉悕瑙勮寖瑙勫垯
            expect(config.rules.naming_convention?.no_space_in_filename).toBe(true);
            expect(config.rules.naming_convention?.action).toBe('block_commit');
            
            // 验证代码质量规则
            expect(config.rules.code_quality?.no_todo).toBe(true);
            expect(config.rules.code_quality?.action).toBe('warning');
        });

        it('测到项目规则文件且用户未显式配置时，应默认开?builtin_rules_enabled', async () => {
            await tempFs.createFile('.eslintrc.json', '{"root": true}');
            await configManager.initialize();
            const config = configManager.getConfig();
            expect(config.rules.builtin_rules_enabled).toBe(false);
            expect(configManager.getRuleSource()).toBe('project');
        });

        it('', async () => {
            await tempFs.createFile('.eslintrc.json', '{"root": true}');
            await tempFs.createFile('.agentreview.yaml', `version: "1.0"
rules:
  builtin_rules_enabled: false
`);
            await configManager.initialize();
            const config = configManager.getConfig();
            expect(config.rules.builtin_rules_enabled).toBe(false);
        });
    });

    describe('测试用例 2.2: YAML 配置文件读取', () => {
        it('应能正确读取和解析 YAML 配置文件', async () => {
            // 单独创建测试配置文件
            const yamlContent = createYamlConfig({
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
            });
            
            await tempFs.createFile('.agentreview.yaml', yamlContent);
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 验证配置
            expect(config.rules.enabled).toBe(true);
            expect(config.rules.strict_mode).toBe(false);
            expect(config.rules.naming_convention?.action).toBe('block_commit');
            expect(config.rules.code_quality?.action).toBe('warning');
        });

        it('', async () => {
            const yamlContent = `version: "1.0"
rules:
  enabled: true
  strict_mode: false
git_hooks:
  auto_install: true
  pre_commit_enabled: true
`;
            
            await tempFs.createFile('.agentreview.yaml', yamlContent);
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            expect(config.git_hooks?.auto_install).toBe(true);
            expect(config.git_hooks?.pre_commit_enabled).toBe(true);
        });
    });

    describe('测试用例 2.3: 配置合并（部分配置）', () => {
        it('部分配置时命名规范可单独禁用', async () => {
            // 仅配置命名规范，禁用
            const yamlContent = `version: "1.0"
rules:
  naming_convention:
    enabled: false
`;
            
            await tempFs.createFile('.agentreview.yaml', yamlContent);
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 命名规范规则应被禁用
            expect(config.rules.naming_convention?.enabled).toBe(false);
            
            // 代码质量规则应使用默认配置（启用）
            expect(config.rules.code_quality?.enabled).toBe(true);
            expect(config.rules.code_quality?.no_todo).toBe(true);
        });

        it('', async () => {
            const yamlContent = `version: "1.0"
rules:
  enabled: true
`;
            
            const configPath = await tempFs.createFile('.agentreview.yaml', yamlContent);
            
            // 设置工作区路径
            (vscode.workspace as any).workspaceFolders = [{
                uri: { fsPath: tempFs.getTempDir() },
                name: 'test-workspace',
                index: 0,
            }];
            
            // 重新单独创建 ConfigManager 以使用新的工作区路径
            configManager = new ConfigManager();
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 其他规则应使用默认
            expect(config.rules.naming_convention?.enabled).toBe(true);
            expect(config.rules.code_quality?.enabled).toBe(true);
        });
    });

    describe('', () => {
        it('朘式配?Settings 时，不应让默认?YAML ?human_readable.auto_generate_on_run_end', async () => {
            const originalGetConfiguration = (vscode.workspace as any).getConfiguration;
            try {
                (vscode.workspace as any).getConfiguration = () => ({
                    // 模拟 VSCode get() 參返回默?
                    get: (key: string) => {
                        const defaults: Record<string, unknown> = {
                            runtimeLog: {},
                            'runtimeLog.enabled': true,
                            'runtimeLog.level': 'info',
                            'runtimeLog.retentionDays': 14,
                            'runtimeLog.fileMode': 'per_run',
                            'runtimeLog.format': 'jsonl',
                            'runtimeLog.baseDirMode': 'workspace_docs_logs',
                            'runtimeLog.humanReadable.enabled': true,
                            'runtimeLog.humanReadable.granularity': 'summary_with_key_events',
                            'runtimeLog.humanReadable.autoGenerateOnRunEnd': false,
                        };
                        return defaults[key];
                    },
                    // 关键：inspect 表示“未显式设置?
                    inspect: (_key: string) => ({
                        defaultValue: undefined,
                        globalValue: undefined,
                        workspaceValue: undefined,
                        workspaceFolderValue: undefined,
                    }),
                });

                const yamlContent = `version: "1.0"
runtime_log:
  enabled: true
  human_readable:
    enabled: true
    granularity: "summary_with_key_events"
    auto_generate_on_run_end: true
`;
                await tempFs.createFile('.agentreview.yaml', yamlContent);
                await configManager.initialize();

                const config = configManager.getConfig();
                expect(config.runtime_log?.human_readable?.auto_generate_on_run_end).toBe(true);
            } finally {
                (vscode.workspace as any).getConfiguration = originalGetConfiguration;
            }
        });

        it('', async () => {
            await configManager.initialize();
            const config = configManager.getConfig();
            expect(config.runtime_log?.human_readable?.auto_generate_on_run_end).toBe(false);
        });
    });

    describe('', () => {
        it('朘式配?Settings 时，不应让默认?YAML ?ai_review.run_on_save', async () => {
            const originalGetConfiguration = (vscode.workspace as any).getConfiguration;
            try {
                (vscode.workspace as any).getConfiguration = () => ({
                    // 模拟 get() 返回默认值（真实 VSCode 场景可能出现）
                    get: (key: string) => {
                        const defaults: Record<string, unknown> = {
                            ai: {},
                            'ai.enabled': false,
                            'ai.runOnSave': false,
                            'ai.timeout': 30000,
                            'ai.temperature': 0.7,
                        };
                        return defaults[key];
                    },
                    // 关键：inspect 表示这些键都“未显式设置”
                    inspect: (_key: string) => ({
                        defaultValue: undefined,
                        globalValue: undefined,
                        workspaceValue: undefined,
                        workspaceFolderValue: undefined,
                    }),
                });

                const yamlContent = `version: "1.0"
ai_review:
  enabled: true
  api_endpoint: "https://example.com/v1/chat/completions"
  timeout: 30000
  action: "warning"
  run_on_save: true
`;
                await tempFs.createFile('.agentreview.yaml', yamlContent);
                await configManager.initialize();

                const config = configManager.getConfig();
                expect(config.ai_review?.enabled).toBe(true);
                expect(config.ai_review?.run_on_save).toBe(true);
            } finally {
                (vscode.workspace as any).getConfiguration = originalGetConfiguration;
            }
        });
    });

    describe('测试用例 2.4: 配置文件错误处理', () => {
        it('应优雅处理格式错?YAML 文件', async () => {
            // 创建格式错?YAML
            const invalidYaml = `version: "1.0"
rules:
  enabled: true
  # 缺少闐拏或格式错?
  naming_convention:
    enabled: true
    action: "block_commit"
    # 格式错：缺少?
    no_space_in_filename:
`;
            
            await tempFs.createFile('.agentreview.yaml', invalidYaml);
            
            // 应不抛出异常，而是使用默认配置
            await expect(configManager.initialize()).resolves.not.toThrow();
            
            const config = configManager.getConfig();
            
            // 应使用默认配置
            expect(config).toBeDefined();
            expect(config.version).toBe('1.0');
        });

        it('应处理不存在的配置文件', async () => {
            // 不创建配罖?
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 应使用默认配置
            expect(config).toBeDefined();
            expect(config.rules.enabled).toBe(true);
        });

        it('', async () => {
            await tempFs.createFile('.agentreview.yaml', '');
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 应使用默认配置
            expect(config).toBeDefined();
        });
    });

    describe('', () => {
        it('配置字段顺序变化不应该触发加载失败或回退', async () => {
            // 单独创建初始配置
            const config1 = {
                version: '1.0',
                rules: {
                    enabled: true,
                    strict_mode: false,
                    naming_convention: {
                        enabled: true,
                        action: 'block_commit' as const,
                        no_space_in_filename: true,
                    },
                    code_quality: {
                        enabled: true,
                        action: 'warning' as const,
                        no_todo: true,
                    },
                },
            };
            
            const yaml1 = createYamlConfig(config1);
            await tempFs.createFile('.agentreview.yaml', yaml1);
            await configManager.initialize();
            
            const configBefore = configManager.getConfig();
            
            // 单独创建相同内容但字段顺序不同的配置
            const yaml2 = `version: "1.0"
rules:
  strict_mode: false
  enabled: true
  code_quality:
    no_todo: true
    enabled: true
    action: "warning"
  naming_convention:
    no_space_in_filename: true
    action: "block_commit"
    enabled: true
`;
            
            // 模拟配置文件变更（直接写入新内容）
            await tempFs.createFile('.agentreview.yaml', yaml2);
            
            // 手动触发重载（在实际场景中由文件监听器触发）
            // 这里我们直接调用 loadConfig 来测试稳定序列化
            const configAfter = await (configManager as any).loadConfig();
            
            // 使用稳定序列化比较配置
            const beforeStr = (configManager as any).stableStringify(configBefore);
            const afterStr = (configManager as any).stableStringify(configAfter);
            
            // 配置应为相同（即使字段顺序不同）
            expect(beforeStr).toBe(afterStr);
        });

        it('', () => {
            const obj1 = {
                a: 1,
                b: 2,
                c: 3,
            };
            
            const obj2 = {
                c: 3,
                a: 1,
                b: 2,
            };
            
            const str1 = (configManager as any).stableStringify(obj1);
            const str2 = (configManager as any).stableStringify(obj2);
            
            expect(str1).toBe(str2);
        });

        it('stableStringify 应处理嵌套对象', () => {
            const obj1 = {
                rules: {
                    enabled: true,
                    strict_mode: false,
                },
            };
            
            const obj2 = {
                rules: {
                    strict_mode: false,
                    enabled: true,
                },
            };
            
            const str1 = (configManager as any).stableStringify(obj1);
            const str2 = (configManager as any).stableStringify(obj2);
            
            expect(str1).toBe(str2);
        });
    });
});


