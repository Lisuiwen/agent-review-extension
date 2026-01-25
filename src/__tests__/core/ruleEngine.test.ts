/**
 * RuleEngine 单元测试
 * 
 * 测试用例覆盖：
 * - 3.1: 文件名空格检查（block_commit）
 * - 3.2: 文件名空格检查（warning）
 * - 3.3: TODO 注释检查
 * - 3.4: 规则禁用
 * - 3.5: 多个文件批量检查
 * - 6.5: 大文件与二进制文件跳过
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RuleEngine } from '../../core/ruleEngine';
import { createMockConfigManager } from '../helpers/mockConfigManager';
import { createTempFileSystem, TempFileSystem } from '../helpers/tempFileSystem';
import { createNamingConventionConfig, createCodeQualityConfig, createDisabledRulesConfig, createTestFileContent } from '../helpers/testFixtures';

describe('RuleEngine', () => {
    let tempFs: TempFileSystem;
    let ruleEngine: RuleEngine;

    beforeEach(async () => {
        // 确保每次测试都创建新的临时文件系统
        if (tempFs) {
            await tempFs.cleanup();
        }
        tempFs = await createTempFileSystem();
    });

    afterEach(async () => {
        if (tempFs) {
            await tempFs.cleanup();
        }
    });

    describe('测试用例 3.1: 文件名空格检查（block_commit）', () => {
        it('应该检测文件名中的空格并返回 error 级别的问题', async () => {
            const configManager = createMockConfigManager(createNamingConventionConfig('block_commit'));
            ruleEngine = new RuleEngine(configManager);
            
            const filePath = tempFs.getPath('test file.ts');
            const content = createTestFileContent.clean();
            
            const issues = await ruleEngine.checkFile(filePath, content);
            
            expect(issues).toHaveLength(1);
            expect(issues[0].rule).toBe('no_space_in_filename');
            expect(issues[0].severity).toBe('error');
            expect(issues[0].message).toContain('文件名包含空格');
            expect(issues[0].file).toBe(filePath);
        });

        it('应该正确识别文件名中的空格位置', async () => {
            const configManager = createMockConfigManager(createNamingConventionConfig('block_commit'));
            ruleEngine = new RuleEngine(configManager);
            
            const filePath = tempFs.getPath('my test file.ts');
            const content = createTestFileContent.clean();
            
            const issues = await ruleEngine.checkFile(filePath, content);
            
            expect(issues[0].message).toContain('my test file.ts');
        });
    });

    describe('测试用例 3.2: 文件名空格检查（warning）', () => {
        it('应该检测文件名中的空格并返回 warning 级别的问题', async () => {
            const configManager = createMockConfigManager(createNamingConventionConfig('warning'));
            ruleEngine = new RuleEngine(configManager);
            
            const filePath = tempFs.getPath('test file.ts');
            const content = createTestFileContent.clean();
            
            const issues = await ruleEngine.checkFile(filePath, content);
            
            expect(issues).toHaveLength(1);
            expect(issues[0].rule).toBe('no_space_in_filename');
            expect(issues[0].severity).toBe('warning');
        });

        it('warning 级别不应该阻止提交', async () => {
            const configManager = createMockConfigManager(createNamingConventionConfig('warning'));
            ruleEngine = new RuleEngine(configManager);
            
            const filePath = tempFs.getPath('test file.ts');
            const content = createTestFileContent.clean();
            
            const issues = await ruleEngine.checkFile(filePath, content);
            
            // warning 级别的问题不应该阻止提交
            expect(issues[0].severity).toBe('warning');
            expect(issues[0].severity).not.toBe('error');
        });
    });

    describe('测试用例 3.3: TODO 注释检查', () => {
        it('应该检测代码中的 TODO 注释', async () => {
            const configManager = createMockConfigManager(createCodeQualityConfig('warning'));
            ruleEngine = new RuleEngine(configManager);
            
            const filePath = tempFs.getPath('test.ts');
            const content = createTestFileContent.withTodo();
            
            const issues = await ruleEngine.checkFile(filePath, content);
            
            // 应该检测到 3 个问题（TODO、FIXME、XXX）
            expect(issues.length).toBeGreaterThanOrEqual(3);
            
            const rules = issues.map(i => i.message);
            expect(rules.some(r => r.includes('TODO'))).toBe(true);
            expect(rules.some(r => r.includes('FIXME'))).toBe(true);
            expect(rules.some(r => r.includes('XXX'))).toBe(true);
        });

        it('应该正确记录 TODO 注释的行号和列号', async () => {
            const configManager = createMockConfigManager(createCodeQualityConfig('warning'));
            ruleEngine = new RuleEngine(configManager);
            
            const filePath = tempFs.getPath('test.ts');
            const content = `function test() {
    // TODO: 需要实现这个功能
    console.log('test');
}`;
            
            const issues = await ruleEngine.checkFile(filePath, content);
            
            const todoIssue = issues.find(i => i.message.includes('TODO'));
            expect(todoIssue).toBeDefined();
            expect(todoIssue?.line).toBe(2);
            expect(todoIssue?.column).toBeGreaterThan(0);
        });

        it('应该检测所有类型的 TODO 标记（不区分大小写）', async () => {
            const configManager = createMockConfigManager(createCodeQualityConfig('warning'));
            ruleEngine = new RuleEngine(configManager);
            
            // 确保临时文件系统已初始化
            if (!tempFs) {
                tempFs = await createTempFileSystem();
            }
            
            const filePath = tempFs.getPath('test.ts');
            const content = `// todo: 小写
// Todo: 首字母大写
// TODO: 全大写
// fixme: 小写
// FIXME: 全大写
`;
            
            const issues = await ruleEngine.checkFile(filePath, content);
            
            // 应该检测到所有变体
            expect(issues.length).toBeGreaterThanOrEqual(5);
        });
    });

    describe('测试用例 3.4: 规则禁用', () => {
        it('禁用规则后不应该进行检查', async () => {
            const configManager = createMockConfigManager({
                rules: {
                    enabled: true,
                    strict_mode: false,
                    code_quality: {
                        enabled: false,
                        action: 'warning',
                        no_todo: true,
                    },
                },
            });
            ruleEngine = new RuleEngine(configManager);
            
            const filePath = tempFs.getPath('test.ts');
            const content = createTestFileContent.withTodo();
            
            const issues = await ruleEngine.checkFile(filePath, content);
            
            // 禁用的规则不应该产生问题
            expect(issues.length).toBe(0);
        });

        it('禁用全局规则后不应该进行任何检查', async () => {
            const configManager = createMockConfigManager(createDisabledRulesConfig());
            ruleEngine = new RuleEngine(configManager);
            
            const filePath = tempFs.getPath('test file.ts');
            const content = createTestFileContent.withTodo();
            
            const issues = await ruleEngine.checkFile(filePath, content);
            
            // 全局规则禁用后不应该产生任何问题
            expect(issues.length).toBe(0);
        });
    });

    describe('测试用例 3.5: 多个文件批量检查', () => {
        it('应该能够同时检查多个文件', async () => {
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
            ruleEngine = new RuleEngine(configManager);
            
            // 创建多个测试文件
            const file1 = await tempFs.createFile('file with space.ts', createTestFileContent.clean());
            const file2 = await tempFs.createFile('normal.ts', createTestFileContent.withTodo());
            const file3 = await tempFs.createFile('clean.ts', createTestFileContent.clean());
            
            const issues = await ruleEngine.checkFiles([file1, file2, file3]);
            
            // 应该检测到文件名空格问题和 TODO 问题
            expect(issues.length).toBeGreaterThan(0);
            
            const file1Issues = issues.filter(i => i.file === file1);
            const file2Issues = issues.filter(i => i.file === file2);
            const file3Issues = issues.filter(i => i.file === file3);
            
            // file1 应该有文件名空格问题
            expect(file1Issues.length).toBeGreaterThan(0);
            expect(file1Issues.some(i => i.rule === 'no_space_in_filename')).toBe(true);
            
            // file2 应该有 TODO 问题
            expect(file2Issues.length).toBeGreaterThan(0);
            expect(file2Issues.some(i => i.rule === 'no_todo')).toBe(true);
            
            // file3 应该没有问题
            expect(file3Issues.length).toBe(0);
        });
    });

    describe('测试用例 6.5: 大文件与二进制文件跳过', () => {
        it('应该跳过超过大小限制的文件', async () => {
            const configManager = createMockConfigManager();
            ruleEngine = new RuleEngine(configManager);
            
            // 创建一个大文件（超过 10MB 限制）
            // 为了测试速度，我们创建一个刚好超过限制的小文件（在实际测试中可以使用更小的阈值）
            const largeFile = await tempFs.createLargeFile('large.ts', 11 * 1024 * 1024);
            
            const issues = await ruleEngine.checkFiles([largeFile]);
            
            // 应该有一个警告，说明文件被跳过
            expect(issues.length).toBe(1);
            expect(issues[0].rule).toBe('file_skipped');
            expect(issues[0].severity).toBe('warning');
            expect(issues[0].message).toContain('文件过大');
        });

        it('应该跳过二进制文件', async () => {
            const configManager = createMockConfigManager();
            ruleEngine = new RuleEngine(configManager);
            
            // 创建二进制文件（包含 null 字节）
            const binaryFile = await tempFs.createBinaryFile('image.png', 100);
            
            // 等待文件系统操作完成
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const issues = await ruleEngine.checkFiles([binaryFile]);
            
            // 应该有一个警告，说明文件被跳过
            expect(issues.length).toBe(1);
            expect(issues[0].rule).toBe('file_skipped');
            expect(issues[0].severity).toBe('warning');
            expect(issues[0].message).toContain('二进制文件');
        });

        it('应该跳过不存在的文件', async () => {
            const configManager = createMockConfigManager();
            ruleEngine = new RuleEngine(configManager);
            
            const nonExistentFile = tempFs.getPath('non-existent.ts');
            
            const issues = await ruleEngine.checkFiles([nonExistentFile]);
            
            // 不存在的文件应该被跳过，不产生问题
            expect(issues.length).toBe(0);
        });

        it('大文件和二进制文件跳过不应该影响其他文件', async () => {
            const configManager = createMockConfigManager({
                rules: {
                    enabled: true,
                    strict_mode: false,
                    code_quality: {
                        enabled: true,
                        action: 'warning',
                        no_todo: true,
                    },
                },
            });
            ruleEngine = new RuleEngine(configManager);
            
            const binaryFile = await tempFs.createBinaryFile('binary.png', 100);
            const normalFile = await tempFs.createFile('normal.ts', createTestFileContent.withTodo());
            
            const issues = await ruleEngine.checkFiles([binaryFile, normalFile]);
            
            // 应该检测到二进制文件跳过警告和正常文件的 TODO 问题
            expect(issues.length).toBeGreaterThan(1);
            
            const binaryIssues = issues.filter(i => i.file === binaryFile);
            const normalIssues = issues.filter(i => i.file === normalFile);
            
            expect(binaryIssues.some(i => i.rule === 'file_skipped')).toBe(true);
            expect(normalIssues.some(i => i.rule === 'no_todo')).toBe(true);
        });
    });
});
