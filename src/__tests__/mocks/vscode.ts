/**
 * VSCode API Mock
 * 
 * 这个文件提供了 VSCode API 的 mock 实现，用于单元测试
 * 模拟 VSCode 扩展运行时的 API 行为
 */

/**
 * Mock 的 OutputChannel
 * 用于模拟 VSCode 的输出通道
 */
export class MockOutputChannel {
    private content: string[] = [];
    private isShown = false;

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

    show(): void {
        this.isShown = true;
    }

    hide(): void {
        this.isShown = false;
    }

    dispose(): void {
        this.content = [];
        this.isShown = false;
    }

    // 测试辅助方法：获取所有日志内容
    getContent(): string[] {
        return [...this.content];
    }

    // 测试辅助方法：检查是否显示
    isVisible(): boolean {
        return this.isShown;
    }
}

/**
 * Mock 的 ExtensionContext
 * 用于模拟 VSCode 扩展上下文
 */
export class MockExtensionContext {
    subscriptions: Array<{ dispose(): void }> = [];
    extensionPath: string;
    workspaceState: Map<string, any> = new Map();
    globalState: Map<string, any> = new Map();

    constructor(extensionPath: string = '/mock/extension/path') {
        this.extensionPath = extensionPath;
    }

    dispose(): void {
        this.subscriptions.forEach(sub => sub.dispose());
        this.subscriptions = [];
    }
}

/**
 * Mock 的 Uri
 * 用于模拟 VSCode 的 Uri 对象
 */
export class MockUri {
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

/**
 * Mock 的 WorkspaceFolder
 * 用于模拟工作区文件夹
 */
export class MockWorkspaceFolder {
    uri: MockUri;
    name: string;
    index: number;

    constructor(uri: MockUri, name: string = 'workspace', index: number = 0) {
        this.uri = uri;
        this.name = name;
        this.index = index;
    }
}

/**
 * 创建完整的 VSCode API Mock
 */
export const createVSCodeMock = () => {
    const outputChannels = new Map<string, MockOutputChannel>();
    const messages: Array<{ type: string; message: string }> = [];

    const mock = {
        window: {
            createOutputChannel: (name: string): MockOutputChannel => {
                if (!outputChannels.has(name)) {
                    outputChannels.set(name, new MockOutputChannel());
                }
                return outputChannels.get(name)!;
            },
            showInformationMessage: (message: string): Thenable<string | undefined> => {
                messages.push({ type: 'info', message });
                return Promise.resolve(undefined);
            },
            showWarningMessage: (message: string): Thenable<string | undefined> => {
                messages.push({ type: 'warning', message });
                return Promise.resolve(undefined);
            },
            showErrorMessage: (message: string): Thenable<string | undefined> => {
                messages.push({ type: 'error', message });
                return Promise.resolve(undefined);
            },
        },
        workspace: {
            workspaceFolders: [] as MockWorkspaceFolder[],
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
            file: (path: string): MockUri => MockUri.file(path),
        },
        RelativePattern: class {
            constructor(public workspaceFolder: any, public pattern: string) {}
        },
        // 测试辅助方法：获取所有显示的消息
        getMessages: () => [...messages],
        // 测试辅助方法：清空消息
        clearMessages: () => {
            messages.length = 0;
        },
        // 测试辅助方法：获取输出通道
        getOutputChannel: (name: string): MockOutputChannel | undefined => {
            return outputChannels.get(name);
        },
    };

    return mock;
};
