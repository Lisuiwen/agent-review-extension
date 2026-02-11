/**
 * Vitest 测试设置文件
 * 
 * 统一处理 VSCode API 的 mock
 */

import { vi } from 'vitest';

// 全局 mock VSCode 模块
// 注意：不能在 vi.mock 中使用顶层导入，需要内联定义
vi.mock('vscode', () => {
    // 内联定义 mock 对象
    const outputChannels = new Map();
    const messages: Array<{ type: string; message: string }> = [];

    class MockOutputChannel {
        private content: string[] = [];
        appendLine(value: string): void {
            this.content.push(value);
        }
        append(value: string): void {
            const lastLine = this.content[this.content.length - 1] || '';
            this.content[this.content.length - 1] = lastLine + value;
        }
        clear(): void {
            this.content = [];
        }
        show(): void {}
        hide(): void {}
        dispose(): void {
            this.content = [];
        }
    }

    class MockUri {
        fsPath: string;
        path: string;
        scheme: string = 'file';
        constructor(fsPath: string) {
            this.fsPath = fsPath;
            this.path = fsPath.replace(/\\/g, '/');
        }
        static file(path: string): MockUri {
            return new MockUri(path);
        }
    }

    return {
        default: {
            commands: {
                registerCommand: (_name: string, cb: (...args: any[]) => any) => ({
                    dispose: () => cb,
                }),
                executeCommand: async () => undefined,
            },
            window: {
                createOutputChannel: (name: string) => {
                    if (!outputChannels.has(name)) {
                        outputChannels.set(name, new MockOutputChannel());
                    }
                    return outputChannels.get(name);
                },
                showInformationMessage: (message: string) => {
                    messages.push({ type: 'info', message });
                    return Promise.resolve(undefined);
                },
                showWarningMessage: (message: string) => {
                    messages.push({ type: 'warning', message });
                    return Promise.resolve(undefined);
                },
                showErrorMessage: (message: string) => {
                    messages.push({ type: 'error', message });
                    return Promise.resolve(undefined);
                },
                showTextDocument: async () => undefined,
            },
            workspace: {
                workspaceFolders: [],
                openTextDocument: async (_target: string) => ({ uri: { fsPath: _target } }),
                getConfiguration: () => ({
                    get: <T>(key: string, defaultValue?: T): T | undefined => {
                        return defaultValue;
                    },
                }),
                createFileSystemWatcher: () => ({
                    onDidChange: () => {},
                    onDidCreate: () => {},
                    onDidDelete: () => {},
                    dispose: () => {},
                }),
            },
            Uri: {
                file: (path: string) => MockUri.file(path),
            },
            RelativePattern: class {
                constructor(public workspaceFolder: any, public pattern: string) {}
            },
        },
        commands: {
            registerCommand: (_name: string, cb: (...args: any[]) => any) => ({
                dispose: () => cb,
            }),
            executeCommand: async () => undefined,
        },
        window: {
            createOutputChannel: (name: string) => {
                if (!outputChannels.has(name)) {
                    outputChannels.set(name, new MockOutputChannel());
                }
                return outputChannels.get(name);
            },
            showInformationMessage: (message: string) => {
                messages.push({ type: 'info', message });
                return Promise.resolve(undefined);
            },
            showWarningMessage: (message: string) => {
                messages.push({ type: 'warning', message });
                return Promise.resolve(undefined);
            },
            showErrorMessage: (message: string) => {
                messages.push({ type: 'error', message });
                return Promise.resolve(undefined);
            },
            showTextDocument: async () => undefined,
        },
        workspace: {
            workspaceFolders: [],
            openTextDocument: async (_target: string) => ({ uri: { fsPath: _target } }),
            getConfiguration: () => ({
                get: <T>(key: string, defaultValue?: T): T | undefined => {
                    return defaultValue;
                },
            }),
            createFileSystemWatcher: () => ({
                onDidChange: () => {},
                onDidCreate: () => {},
                onDidDelete: () => {},
                dispose: () => {},
            }),
        },
        Uri: {
            file: (path: string) => MockUri.file(path),
        },
        RelativePattern: class {
            constructor(public workspaceFolder: any, public pattern: string) {}
        },
    };
});
