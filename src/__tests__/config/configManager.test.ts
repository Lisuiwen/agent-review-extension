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
        // 创建临时文件系统
        tempFs = await createTempFileSystem();
        
        // 设置工作区路径（ConfigManager 需要工作区路径）
        (vscode.workspace as any).workspaceFolders = [{
            uri: { fsPath: tempFs.getTempDir() },
            name: 'test-workspace',
            index: 0,
        }];
        
        // 创建 ConfigManager 实例（每次测试都创建新的，确保使用正确的工作区路径）
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
        it('应该在没有配置文件时使用默认配置', async () => {
            // 不创建配置文件，直接初始化
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 验证默认配置的基本结构
            expect(config).toBeDefined();
            expect(config.version).toBe('1.0');
            expect(config.rules.enabled).toBe(true);
            expect(config.rules.strict_mode).toBe(false);
            expect(config.rules.naming_convention?.enabled).toBe(true);
            expect(config.rules.code_quality?.enabled).toBe(true);
        });

        it('默认配置应该包含所有必需的规则', async () => {
            await configManager.initialize();
            const config = configManager.getConfig();
            
            // 验证命名规范规则
            expect(config.rules.naming_convention?.no_space_in_filename).toBe(true);
            expect(config.rules.naming_convention?.action).toBe('block_commit');
            
            // 验证代码质量规则
            expect(config.rules.code_quality?.no_todo).toBe(true);
            expect(config.rules.code_quality?.action).toBe('warning');
        });
    });

    describe('测试用例 2.2: YAML 配置文件读取', () => {
        it('应该能够正确读取和解析 YAML 配置文件', async () => {
            // 创建测试配置文件
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
            
            // 验证配置被正确读取
            expect(config.rules.enabled).toBe(true);
            expect(config.rules.strict_mode).toBe(false);
            expect(config.rules.naming_convention?.action).toBe('block_commit');
            expect(config.rules.code_quality?.action).toBe('warning');
        });

        it('应该能够读取包含 git_hooks 的配置', async () => {
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
        it('部分配置应该与默认配置合并', async () => {
            // 只配置命名规范规则，禁用它
            const yamlContent = `version: "1.0"
rules:
  naming_convention:
    enabled: false
`;
            
            await tempFs.createFile('.agentreview.yaml', yamlContent);
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 命名规范规则应该被禁用
            expect(config.rules.naming_convention?.enabled).toBe(false);
            
            // 代码质量规则应该使用默认配置（启用）
            expect(config.rules.code_quality?.enabled).toBe(true);
            expect(config.rules.code_quality?.no_todo).toBe(true);
        });

        it('未配置的字段应该使用默认值', async () => {
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
            
            // 重新创建 ConfigManager 以使用新的工作区路径
            configManager = new ConfigManager();
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 未配置的规则应该使用默认值
            expect(config.rules.naming_convention?.enabled).toBe(true);
            expect(config.rules.code_quality?.enabled).toBe(true);
        });
    });

    describe('运行日志配置优先级', () => {
        it('未显式配置 Settings 时，不应让默认值覆盖 YAML 的 human_readable.auto_generate_on_run_end', async () => {
            const originalGetConfiguration = (vscode.workspace as any).getConfiguration;
            try {
                (vscode.workspace as any).getConfiguration = () => ({
                    // 模拟 VSCode get() 可能返回默认值
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
                    // 关键：inspect 表示“未显式设置”
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

        it('默认配置应与 Settings 默认值保持一致（auto_generate_on_run_end=false）', async () => {
            await configManager.initialize();
            const config = configManager.getConfig();
            expect(config.runtime_log?.human_readable?.auto_generate_on_run_end).toBe(false);
        });
    });

    describe('测试用例 2.4: 配置文件错误处理', () => {
        it('应该优雅处理格式错误的 YAML 文件', async () => {
            // 创建格式错误的 YAML
            const invalidYaml = `version: "1.0"
rules:
  enabled: true
  # 缺少闭合括号或格式错误
  naming_convention:
    enabled: true
    action: "block_commit"
    # 格式错误：缺少值
    no_space_in_filename:
`;
            
            await tempFs.createFile('.agentreview.yaml', invalidYaml);
            
            // 应该不抛出异常，而是使用默认配置
            await expect(configManager.initialize()).resolves.not.toThrow();
            
            const config = configManager.getConfig();
            
            // 应该使用默认配置
            expect(config).toBeDefined();
            expect(config.version).toBe('1.0');
        });

        it('应该处理不存在的配置文件', async () => {
            // 不创建配置文件
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 应该使用默认配置
            expect(config).toBeDefined();
            expect(config.rules.enabled).toBe(true);
        });

        it('应该处理空配置文件', async () => {
            await tempFs.createFile('.agentreview.yaml', '');
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 应该使用默认配置
            expect(config).toBeDefined();
        });
    });

    describe('测试用例 2.5: 配置重载顺序稳定性', () => {
        it('配置字段顺序变化不应该触发"加载失败"回退', async () => {
            // 创建初始配置
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
            
            // 创建相同内容但字段顺序不同的配置
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
            
            // 配置应该被视为相同（即使字段顺序不同）
            expect(beforeStr).toBe(afterStr);
        });

        it('stableStringify 应该对相同内容但不同顺序的对象产生相同结果', () => {
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

        it('stableStringify 应该处理嵌套对象', () => {
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
