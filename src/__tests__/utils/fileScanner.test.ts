/**
 * FileScanner 单元测试
 * 
 * 测试用例覆盖：
 * - 6.3: 文件排除（基础 glob）
 * - 6.4: 复杂 Glob 排除（{a,b}、[0-9]）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileScanner } from '../../utils/fileScanner';
import { createTempFileSystem, TempFileSystem } from '../helpers/tempFileSystem';
import * as vscode from 'vscode';

describe('FileScanner', () => {
    let tempFs: TempFileSystem;
    let fileScanner: FileScanner;

    beforeEach(async () => {
        // 确保每次测试都创建新的临时文件系统
        if (tempFs) {
            await tempFs.cleanup();
        }
        tempFs = await createTempFileSystem();
        
        // 设置工作区路径
        (vscode.workspace as any).workspaceFolders = [{
            uri: { fsPath: tempFs.getTempDir() },
            name: 'test-workspace',
            index: 0,
        }];
        
        fileScanner = new FileScanner();
    });

    afterEach(async () => {
        if (tempFs) {
            await tempFs.cleanup();
        }
    });

    describe('测试用例 6.3: 文件排除（基础 glob）', () => {
        it('应该排除匹配 *.log 模式的文件', () => {
            const exclusions = {
                files: ['*.log'],
            };
            
            expect(fileScanner.shouldExclude('test.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('app.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('test.ts', exclusions)).toBe(false);
        });

        it('应该排除匹配 test-*.ts 模式的文件', () => {
            const exclusions = {
                files: ['test-*.ts'],
            };
            
            expect(fileScanner.shouldExclude('test-1.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('test-file.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('normal.ts', exclusions)).toBe(false);
        });

        it('应该排除匹配目录模式的文件', () => {
            const exclusions = {
                directories: ['node_modules'],
            };
            
            expect(fileScanner.shouldExclude('/path/to/node_modules/file.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('/path/to/node_modules/sub/file.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('/path/to/src/file.ts', exclusions)).toBe(false);
        });

        it('应该排除匹配多个模式的文件', () => {
            const exclusions = {
                files: ['*.log', '*.tmp'],
                directories: ['dist', 'build'],
            };
            
            expect(fileScanner.shouldExclude('test.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('test.tmp', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('/path/to/dist/file.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('/path/to/build/file.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('test.ts', exclusions)).toBe(false);
        });

        it('应该处理 Windows 路径', () => {
            const exclusions = {
                files: ['*.log'],
            };
            
            expect(fileScanner.shouldExclude('C:\\path\\to\\test.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('C:\\path\\to\\test.ts', exclusions)).toBe(false);
        });
    });

    describe('测试用例 6.4: 复杂 Glob 排除（{a,b}、[0-9]）', () => {
        it('应该支持花括号模式 {a,b}', () => {
            const exclusions = {
                files: ['test-{a,b}.ts'],
            };
            
            expect(fileScanner.shouldExclude('test-a.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('test-b.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('test-c.ts', exclusions)).toBe(false);
        });

        it('应该支持字符类模式 [0-9]', () => {
            const exclusions = {
                files: ['report-[0-9].log'],
            };
            
            expect(fileScanner.shouldExclude('report-1.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('report-5.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('report-9.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('report-a.log', exclusions)).toBe(false);
            expect(fileScanner.shouldExclude('report-10.log', exclusions)).toBe(false);
        });

        it('应该支持多个复杂模式', () => {
            const exclusions = {
                files: ['test-{a,b}.ts', 'report-[0-9].log'],
            };
            
            expect(fileScanner.shouldExclude('test-a.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('test-b.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('report-1.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('report-5.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('normal.ts', exclusions)).toBe(false);
        });

        it('应该支持目录中的复杂 glob 模式', () => {
            const exclusions = {
                directories: ['test-*'],
            };
            
            expect(fileScanner.shouldExclude('/path/to/test-1/file.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('/path/to/test-abc/file.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('/path/to/src/file.ts', exclusions)).toBe(false);
        });

        it('应该支持 ** 通配符', () => {
            const exclusions = {
                files: ['**/*.log'],
            };
            
            expect(fileScanner.shouldExclude('test.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('/path/to/test.log', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('/deep/path/to/test.log', exclusions)).toBe(true);
        });

        it('应该支持 ? 通配符', () => {
            const exclusions = {
                files: ['test?.ts'],
            };
            
            expect(fileScanner.shouldExclude('test1.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('testa.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('test.ts', exclusions)).toBe(false);
            expect(fileScanner.shouldExclude('test12.ts', exclusions)).toBe(false);
        });
    });

    describe('边界情况', () => {
        it('没有排除规则时不应该排除任何文件', () => {
            expect(fileScanner.shouldExclude('test.ts', {})).toBe(false);
            expect(fileScanner.shouldExclude('test.ts', undefined as any)).toBe(false);
        });

        it('应该处理空字符串模式', () => {
            const exclusions = {
                files: [''],
            };
            
            expect(fileScanner.shouldExclude('test.ts', exclusions)).toBe(false);
        });

        it('应该处理包含特殊字符的文件名', () => {
            const exclusions = {
                files: ['*.ts'],
            };
            
            expect(fileScanner.shouldExclude('test-file.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('test_file.ts', exclusions)).toBe(true);
            expect(fileScanner.shouldExclude('test.file.ts', exclusions)).toBe(true);
        });
    });
});
