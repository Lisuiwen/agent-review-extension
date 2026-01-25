/**
 * GitHookManager 单元测试
 * 
 * 测试用例覆盖：
 * - 5.6: Hook 使用内置 Node 路径（Windows/Unix 脚本生成）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GitHookManager } from '../../hooks/gitHookManager';
import * as path from 'path';
import { MockExtensionContext } from '../mocks/vscode';

describe('GitHookManager', () => {
    let gitHookManager: GitHookManager;
    let mockContext: any;

    beforeEach(() => {
        // 创建 mock context，不依赖 vscode mock
        mockContext = {
            extensionPath: '/mock/extension/path',
            subscriptions: [],
            workspaceState: new Map(),
            globalState: new Map(),
        };
        gitHookManager = new GitHookManager(mockContext);
    });

    describe('测试用例 5.6: Hook 使用内置 Node 路径', () => {
        it('Windows 脚本应该使用完整 Node 路径', () => {
            // 模拟 Windows 环境
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', {
                value: 'win32',
                writable: true,
            });

            try {
                // 设置工作区根目录
                (gitHookManager as any).workspaceRoot = 'C:\\workspace\\test';
                
                const script = (gitHookManager as any).generateHookScript();
                
                // 验证脚本包含完整 Node 路径
                expect(script).toContain(process.execPath);
                expect(script).toContain('set "WORKSPACE_ROOT=');
                expect(script).toContain('@echo off');
                
                // 验证路径使用反斜杠（Windows 格式）
                expect(script).toContain('C:\\workspace\\test');
                
                // 验证使用引号包裹路径（避免空格问题）
                expect(script).toMatch(/set "WORKSPACE_ROOT=/);
            } finally {
                // 恢复原始平台
                Object.defineProperty(process, 'platform', {
                    value: originalPlatform,
                    writable: true,
                });
            }
        });

        it('Unix 脚本应该使用完整 Node 路径', () => {
            // 模拟 Unix 环境
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', {
                value: 'linux',
                writable: true,
            });

            try {
                // 设置工作区根目录
                (gitHookManager as any).workspaceRoot = '/workspace/test';
                
                const script = (gitHookManager as any).generateHookScript();
                
                // 验证脚本包含完整 Node 路径
                expect(script).toContain(process.execPath);
                expect(script).toContain('export WORKSPACE_ROOT=');
                expect(script).toContain('#!/bin/sh');
                
                // 验证路径使用正斜杠（Unix 格式）
                expect(script).toContain('/workspace/test');
                
                // 验证使用引号包裹路径
                expect(script).toMatch(/export WORKSPACE_ROOT="/);
            } finally {
                // 恢复原始平台
                Object.defineProperty(process, 'platform', {
                    value: originalPlatform,
                    writable: true,
                });
            }
        });

        it('Windows 脚本应该使用 path.normalize 处理路径', () => {
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', {
                value: 'win32',
                writable: true,
            });

            try {
                // 设置包含混合斜杠的路径
                (gitHookManager as any).workspaceRoot = 'C:/workspace\\test';
                
                const script = (gitHookManager as any).generateHookScript();
                
                // 验证路径被规范化
                const normalizedPath = path.normalize('C:/workspace\\test');
                expect(script).toContain(normalizedPath);
            } finally {
                Object.defineProperty(process, 'platform', {
                    value: originalPlatform,
                    writable: true,
                });
            }
        });

        it('Unix 脚本应该正确处理路径', () => {
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', {
                value: 'darwin', // macOS
                writable: true,
            });

            try {
                (gitHookManager as any).workspaceRoot = '/Users/test/workspace';
                
                const script = (gitHookManager as any).generateHookScript();
                
                // 验证路径正确包含
                expect(script).toContain('/Users/test/workspace');
                expect(script).toContain(process.execPath);
            } finally {
                Object.defineProperty(process, 'platform', {
                    value: originalPlatform,
                    writable: true,
                });
            }
        });

        it('脚本应该包含错误处理逻辑', () => {
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', {
                value: 'win32',
                writable: true,
            });

            try {
                (gitHookManager as any).workspaceRoot = 'C:\\workspace';
                
                const script = (gitHookManager as any).generateHookScript();
                
                // Windows 脚本应该包含错误检查
                expect(script).toContain('if errorlevel 1');
                expect(script).toContain('exit /b 1');
            } finally {
                Object.defineProperty(process, 'platform', {
                    value: originalPlatform,
                    writable: true,
                });
            }
        });

        it('Unix 脚本应该包含错误处理逻辑', () => {
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', {
                value: 'linux',
                writable: true,
            });

            try {
                (gitHookManager as any).workspaceRoot = '/workspace';
                
                const script = (gitHookManager as any).generateHookScript();
                
                // Unix 脚本应该包含退出码处理
                expect(script).toContain('exit $?');
            } finally {
                Object.defineProperty(process, 'platform', {
                    value: originalPlatform,
                    writable: true,
                });
            }
        });
    });
});
