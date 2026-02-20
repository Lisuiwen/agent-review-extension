/**
 * ConfigManager 鍗曞厓娴嬭瘯
 * 
 * 测试用例覆盖?
 * - 2.1: 榛樿閰嶇疆鍔犺浇
 * - 2.2: YAML 閰嶇疆鏂囦欢璇诲彇
 * - 2.3: 閰嶇疆鍚堝苟锛堥儴鍒嗛厤缃級
 * - 2.4: 閰嶇疆鏂囦欢閿欒澶勭悊
 * - 2.5: 配置重载顺序稳定性（stableStringify?
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
        // 鍒涘缓涓存椂鏂囦欢绯荤粺
        tempFs = await createTempFileSystem();
        
        // 设置工作区路径（ConfigManager 要工作区跾?
        (vscode.workspace as any).workspaceFolders = [{
            uri: { fsPath: tempFs.getTempDir() },
            name: 'test-workspace',
            index: 0,
        }];
        
        // 鍒涘缓 ConfigManager 瀹炰緥锛堟瘡娆℃祴璇曢兘鍒涘缓鏂扮殑锛岀‘淇濅娇鐢ㄦ纭殑宸ヤ綔鍖鸿矾寰勶級
        configManager = new ConfigManager();
    });

    afterEach(async () => {
        // 娓呯悊涓存椂鏂囦欢
        if (tempFs) {
            await tempFs.cleanup();
        }
        if (configManager) {
            configManager.dispose();
        }
    });

    describe('娴嬭瘯鐢ㄤ緥 2.1: 榛樿閰嶇疆鍔犺浇', () => {
        it('搴旇鍦ㄦ病鏈夐厤缃枃浠舵椂浣跨敤榛樿閰嶇疆', async () => {
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
            
            // 楠岃瘉浠ｇ爜璐ㄩ噺瑙勫垯
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

    describe('娴嬭瘯鐢ㄤ緥 2.2: YAML 閰嶇疆鏂囦欢璇诲彇', () => {
        it('应能正确读取和解?YAML 配置文件', async () => {
            // 鍒涘缓娴嬭瘯閰嶇疆鏂囦欢
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
            
            // 验证配置?
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

    describe('娴嬭瘯鐢ㄤ緥 2.3: 閰嶇疆鍚堝苟锛堥儴鍒嗛厤缃級', () => {
        it('', async () => {
            // 叅网名范则，禁用?
            const yamlContent = `version: "1.0"
rules:
  naming_convention:
    enabled: false
`;
            
            await tempFs.createFile('.agentreview.yaml', yamlContent);
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 命名规范规则应?
            expect(config.rules.naming_convention?.enabled).toBe(false);
            
            // 浠ｇ爜璐ㄩ噺瑙勫垯搴旇浣跨敤榛樿閰嶇疆锛堝惎鐢級
            expect(config.rules.code_quality?.enabled).toBe(true);
            expect(config.rules.code_quality?.no_todo).toBe(true);
        });

        it('', async () => {
            const yamlContent = `version: "1.0"
rules:
  enabled: true
`;
            
            const configPath = await tempFs.createFile('.agentreview.yaml', yamlContent);
            
            // 设置工作区路?
            (vscode.workspace as any).workspaceFolders = [{
                uri: { fsPath: tempFs.getTempDir() },
                name: 'test-workspace',
                index: 0,
            }];
            
            // 閲嶆柊鍒涘缓 ConfigManager 浠ヤ娇鐢ㄦ柊鐨勫伐浣滃尯璺緞
            configManager = new ConfigManager();
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 朅罚规则应使用默?
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

    describe('娴嬭瘯鐢ㄤ緥 2.4: 閰嶇疆鏂囦欢閿欒澶勭悊', () => {
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
            
            // 搴旇涓嶆姏鍑哄紓甯革紝鑰屾槸浣跨敤榛樿閰嶇疆
            await expect(configManager.initialize()).resolves.not.toThrow();
            
            const config = configManager.getConfig();
            
            // 搴旇浣跨敤榛樿閰嶇疆
            expect(config).toBeDefined();
            expect(config.version).toBe('1.0');
        });

        it('搴旇澶勭悊涓嶅瓨鍦ㄧ殑閰嶇疆鏂囦欢', async () => {
            // 不创建配罖?
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 搴旇浣跨敤榛樿閰嶇疆
            expect(config).toBeDefined();
            expect(config.rules.enabled).toBe(true);
        });

        it('', async () => {
            await tempFs.createFile('.agentreview.yaml', '');
            await configManager.initialize();
            
            const config = configManager.getConfig();
            
            // 搴旇浣跨敤榛樿閰嶇疆
            expect(config).toBeDefined();
        });
    });

    describe('', () => {
        it('配置字顺序变化不应该触?加载失败"回', async () => {
            // 鍒涘缓鍒濆閰嶇疆
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
            
            // 鍒涘缓鐩稿悓鍐呭浣嗗瓧娈甸『搴忎笉鍚岀殑閰嶇疆
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
            
            // 模拟配置文件变更（直接写入新内?
            await tempFs.createFile('.agentreview.yaml', yaml2);
            
            // 鎵嬪姩瑙﹀彂閲嶈浇锛堝湪瀹為檯鍦烘櫙涓敱鏂囦欢鐩戝惉鍣ㄨЕ鍙戯級
            // 杩欓噷鎴戜滑鐩存帴璋冪敤 loadConfig 鏉ユ祴璇曠ǔ瀹氬簭鍒楀寲
            const configAfter = await (configManager as any).loadConfig();
            
            // 使用稳定序列化比较配?
            const beforeStr = (configManager as any).stableStringify(configBefore);
            const afterStr = (configManager as any).stableStringify(configAfter);
            
            // 配置应为相同（即使字顺序不同?
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

        it('stableStringify 搴旇澶勭悊宓屽瀵硅薄', () => {
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


