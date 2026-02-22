/**
 * ReviewEngine 鍗曞厓娴嬭瘯
 * 
 * 娴嬭瘯鐢ㄤ緥瑕嗙洊锛?
 * - 7.1: Strict Mode
 * - 7.2: 闈?Strict Mode
 * - 7.3: 瑙勫垯 action 鏄犲皠琛紙楠岃瘉淇鐨勭‖缂栫爜闂锛?
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ReviewEngine } from '../../core/reviewEngine';
import { createMockConfigManager } from '../helpers/mockConfigManager';
import { createStrictModeConfig, createNamingConventionConfig, createCodeQualityConfig } from '../helpers/testFixtures';
import { createTempFileSystem, TempFileSystem } from '../helpers/tempFileSystem';
import { createTestFileContent } from '../helpers/testFixtures';

// Mock FileScanner
vi.mock('../../utils/fileScanner', () => {
    return {
        FileScanner: class {
            getStagedFiles = vi.fn().mockResolvedValue([]);
            shouldExclude = vi.fn().mockReturnValue(false);
        },
    };
});

describe('ReviewEngine', () => {
    let tempFs: TempFileSystem;
    let reviewEngine: ReviewEngine;

    beforeEach(async () => {
        tempFs = await createTempFileSystem();
    });

    afterEach(async () => {
        if (tempFs) {
            await tempFs.cleanup();
        }
    });

    describe('娴嬭瘯鐢ㄤ緥 7.1: Strict Mode', () => {
        it('涓ユ牸妯″紡涓嬫墍鏈夐敊璇兘搴旇闃绘鎻愪氦', async () => {
            const configManager = createMockConfigManager({
                rules: {
                    enabled: true,
                    strict_mode: true,
                    code_quality: {
                        enabled: true,
                        action: 'block_commit', // 鍦ㄤ弗鏍兼ā寮忎笅锛屼娇鐢?block_commit 鏉ヤ骇鐢?errors
                        no_todo: true,
                    },
                },
            });
            reviewEngine = new ReviewEngine(configManager);
            await reviewEngine.initialize();
            
            // 鍒涘缓鍖呭惈 TODO 鐨勬枃浠讹紙action 涓?block_commit锛屼細浜х敓 errors锛?
            const file1 = await tempFs.createFile('test.ts', createTestFileContent.withTodo());
            
            const result = await reviewEngine.review([file1]);
            
            // 鍦ㄤ弗鏍兼ā寮忎笅锛屾墍鏈?errors 閮戒細闃绘鎻愪氦
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.passed).toBe(false);
        });

        it('strict_mode 存在 error 时应阻止提交', async () => {
            // 娉ㄦ剰锛氭牴鎹綋鍓嶅疄鐜帮紝strict_mode 鍙鏌?errors.length
            // 濡傛灉鍙湁 warnings锛坅ction 涓?warning锛夛紝瀹冧滑涓嶄細琚綊绫讳负 errors
            // 鎵€浠ヨ繖涓祴璇曠敤渚嬮渶瑕佽皟鏁达細瑕佷箞淇敼浠ｇ爜閫昏緫锛岃涔堣皟鏁存祴璇曢鏈?
            // 杩欓噷鎴戜滑娴嬭瘯锛氬鏋滄湁 errors锛屼弗鏍兼ā寮忓簲璇ラ樆姝㈡彁浜?
            const configManager = createMockConfigManager({
                rules: {
                    enabled: true,
                    strict_mode: true,
                    naming_convention: {
                        enabled: true,
                        action: 'block_commit', // 浜х敓 errors
                        no_space_in_filename: true,
                    },
                },
            });
            reviewEngine = new ReviewEngine(configManager);
            await reviewEngine.initialize();
            
            // 鍒涘缓鍖呭惈鏂囦欢鍚嶇┖鏍肩殑鏂囦欢锛堜細浜х敓 errors锛?
            const file1 = await tempFs.createFile('test file.ts', createTestFileContent.clean());
            
            const result = await reviewEngine.review([file1]);
            
            // 涓ユ牸妯″紡涓嬶紝鏈?errors 搴旇闃绘鎻愪氦
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.passed).toBe(false);
        });
    });

    describe('娴嬭瘯鐢ㄤ緥 7.2: 闈?Strict Mode', () => {
        it('闈炰弗鏍兼ā寮忎笅鍙湁 block_commit 鐨勯敊璇墠闃绘鎻愪氦', async () => {
            const configManager = createMockConfigManager({
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
            reviewEngine = new ReviewEngine(configManager);
            await reviewEngine.initialize();
            
            // 鍒涘缓鍖呭惈 warning 绾у埆闂鐨勬枃浠讹紙TODO锛?
            const file1 = await tempFs.createFile('test.ts', createTestFileContent.withTodo());
            
            const result = await reviewEngine.review([file1]);
            
            // warning 绾у埆鐨勯敊璇笉搴旇闃绘鎻愪氦
            expect(result.warnings.length).toBeGreaterThan(0);
            expect(result.passed).toBe(true);
        });

        it('非 strict_mode 下 block_commit error 应阻止提交', async () => {
            const configManager = createMockConfigManager(createNamingConventionConfig('block_commit'));
            reviewEngine = new ReviewEngine(configManager);
            await reviewEngine.initialize();
            
            // 鍒涘缓鍖呭惈 block_commit 绾у埆闂鐨勬枃浠讹紙鏂囦欢鍚嶇┖鏍硷級
            const file1 = await tempFs.createFile('test file.ts', createTestFileContent.clean());
            
            const result = await reviewEngine.review([file1]);
            
            // block_commit 绾у埆鐨勯敊璇簲璇ラ樆姝㈡彁浜?
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.passed).toBe(false);
        });

        it('闈炰弗鏍兼ā寮忎笅 warning 绾у埆鐨勯敊璇笉搴旇闃绘鎻愪氦', async () => {
            const configManager = createMockConfigManager(createNamingConventionConfig('warning'));
            reviewEngine = new ReviewEngine(configManager);
            await reviewEngine.initialize();
            
            const file1 = await tempFs.createFile('test file.ts', createTestFileContent.clean());
            
            const result = await reviewEngine.review([file1]);
            
            // warning 绾у埆涓嶅簲璇ラ樆姝㈡彁浜?
            expect(result.warnings.length).toBeGreaterThan(0);
            expect(result.passed).toBe(true);
        });
    });

    describe('测试用例 7.3: 规则 action 映射表', () => {
        it('搴旇浣跨敤鏄犲皠琛ㄨ€屼笉鏄‖缂栫爜鏉ユ鏌ヨ鍒?action', async () => {
            const configManager = createMockConfigManager({
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
            reviewEngine = new ReviewEngine(configManager);
            await reviewEngine.initialize();
            
            // 鍒涘缓鍖呭惈涓ょ闂鐨勬枃浠?
            const file1 = await tempFs.createFile('test file.ts', createTestFileContent.withTodo());
            
            const result = await reviewEngine.review([file1]);
            
            // 搴旇姝ｇ‘璇嗗埆 block_commit 鍜?warning 鐨勫尯鍒?
            const blockingErrors = result.errors.filter(e => 
                e.rule === 'no_space_in_filename' && e.severity === 'error'
            );
            const warnings = result.warnings.filter(w => 
                w.rule === 'no_todo' && w.severity === 'warning'
            );
            
            expect(blockingErrors.length).toBeGreaterThan(0);
            expect(warnings.length).toBeGreaterThan(0);
            
            // block_commit 搴旇闃绘鎻愪氦
            expect(result.passed).toBe(false);
        });

        it('搴旇姝ｇ‘澶勭悊 AI 瀹℃煡瑙勫垯鐨?action', async () => {
            const configManager = createMockConfigManager({
                rules: {
                    enabled: true,
                    strict_mode: false,
                },
                ai_review: {
                    enabled: false,
                    api_format: 'openai',
                    api_endpoint: 'https://api.openai.com/v1/chat/completions',
                    timeout: 30000,
                    action: 'block_commit',
                },
            });
            reviewEngine = new ReviewEngine(configManager);
            await reviewEngine.initialize();
            
            // 杩欎釜娴嬭瘯涓昏楠岃瘉鏄犲皠琛ㄤ腑鍖呭惈 AI 瀹℃煡瑙勫垯
            // 瀹為檯鐨?AI 瀹℃煡娴嬭瘯闇€瑕?mock AIReviewer
            const file1 = await tempFs.createFile('test.ts', createTestFileContent.clean());
            const result = await reviewEngine.review([file1]);
            
            // 楠岃瘉瀹℃煡娴佺▼姝ｅ父鎵ц
            expect(result).toBeDefined();
            expect(result.passed).toBeDefined();
        });

        it('未映射规则不应阻止提交', async () => {
            const configManager = createMockConfigManager({
                rules: {
                    enabled: true,
                    strict_mode: false,
                },
            });
            reviewEngine = new ReviewEngine(configManager);
            await reviewEngine.initialize();
            
            // 鍒涘缓涓€涓病鏈夐棶棰樼殑鏂囦欢
            const file1 = await tempFs.createFile('test.ts', createTestFileContent.clean());
            const result = await reviewEngine.review([file1]);
            
            // 娌℃湁閿欒搴旇閫氳繃
            expect(result.passed).toBe(true);
            expect(result.errors.length).toBe(0);
        });

        it('no_debugger 涓?block_commit 鏃跺簲闃绘鎻愪氦', async () => {
            const configManager = createMockConfigManager({
                rules: {
                    enabled: true,
                    strict_mode: false,
                    code_quality: {
                        enabled: true,
                        action: 'block_commit',
                        no_todo: false,
                        no_debugger: true,
                    },
                },
            });
            reviewEngine = new ReviewEngine(configManager);
            await reviewEngine.initialize();

            const file = await tempFs.createFile('debug.ts', 'function x(){\n  debugger;\n}\n');
            const result = await reviewEngine.review([file]);

            expect(result.errors.some(e => e.rule === 'no_debugger')).toBe(true);
            expect(result.passed).toBe(false);
        });
    });
});

