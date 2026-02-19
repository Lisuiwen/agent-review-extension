/**
 * Phase 3 功能单元测试（Vitest）
 *
 * 目的：
 * 1. 覆盖当前已实现的“定位/高亮/命令注册”行为
 * 2. 验证关键边界：越界行列、无效路径
 *
 * 说明：
 * - 使用 vi.mock('vscode') 做最小化模拟
 * - 只断言关键调用与参数，不依赖真实 VSCode
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();
const contextValues = new Map<string, unknown>();
const messages: Array<{ type: string; message: string }> = [];
let lastTreeView: { fireSelection: (selection: Array<{ issue?: unknown; filePath?: string }>) => void } | null = null;
let lastEditor: {
    selection: unknown;
    setDecorations: (decoration: unknown, ranges: unknown[]) => void;
    revealRange: (range: unknown, type: unknown) => void;
    decorationCalls: Array<{ decoration: unknown; ranges: unknown[] }>;
} | null = null;
let openTextDocumentBehavior: ((path: string) => Promise<unknown>) | null = null;
const flushPromises = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0));
};

vi.mock('vscode', () => {
    class TreeItem {
        constructor(public label: string, public collapsibleState: number) {}
        public tooltip?: string;
        public description?: string;
        public iconPath?: unknown;
        public command?: { command: string; title: string; arguments: unknown[] };
        public resourceUri?: unknown;
        public contextValue?: string;
    }

    class ThemeIcon {
        public static File = new ThemeIcon('file');
        constructor(public id: string, public color?: unknown) {}
    }

    class ThemeColor {
        constructor(public id: string) {}
    }

    class Position {
        constructor(public line: number, public character: number) {}
        public isBefore(other: Position): boolean {
            if (this.line < other.line) {
                return true;
            }
            if (this.line > other.line) {
                return false;
            }
            return this.character < other.character;
        }
    }

    class Range {
        public start: Position;
        public end: Position;
        constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
            this.start = new Position(startLine, startCharacter);
            this.end = new Position(endLine, endCharacter);
        }
    }

    class Selection {
        constructor(public start: Position, public end: Position) {}
    }

    class WorkspaceEdit {
        public edits: Array<{ uri: { fsPath: string }; range: Range; text: string }> = [];
        replace(uri: { fsPath: string }, range: Range, text: string): void {
            this.edits.push({ uri, range, text });
        }
    }

    class EventEmitter<T> {
        private handlers: Array<(event: T) => void> = [];
        public event = (handler: (event: T) => void) => {
            this.handlers.push(handler);
            return { dispose: () => {} };
        };
        public fire = (event: T) => {
            this.handlers.forEach(handler => handler(event));
        };
        public dispose = () => {
            this.handlers = [];
        };
    }

    const TextEditorRevealType = {
        InCenter: 0
    };

    const Uri = {
        file: (path: string) => ({ fsPath: path })
    };

    const TreeItemCollapsibleState = {
        None: 0,
        Collapsed: 1,
        Expanded: 2
    };

    const window = {
        createTreeView: () => {
            const selectionHandlers: Array<(event: { selection: Array<{ issue?: unknown; filePath?: string }> }) => void> = [];
            const treeView = {
                onDidChangeSelection: (handler: (event: { selection: Array<{ issue?: unknown; filePath?: string }> }) => void) => {
                    selectionHandlers.push(handler);
                    return { dispose: () => {} };
                },
                dispose: () => {}
            };
            lastTreeView = {
                fireSelection: (selection) => {
                    selectionHandlers.forEach(handler => handler({ selection }));
                }
            };
            return treeView;
        },
        createTextEditorDecorationType: (options: unknown) => ({ options }),
        showTextDocument: async () => {
            const editor = {
                selection: null,
                decorationCalls: [] as Array<{ decoration: unknown; ranges: unknown[] }>,
                setDecorations: (decoration: unknown, ranges: unknown[]) => {
                    editor.decorationCalls.push({ decoration, ranges });
                },
                revealRange: vi.fn()
            };
            lastEditor = editor;
            return editor;
        },
        showWarningMessage: (message: string) => {
            messages.push({ type: 'warning', message });
            return Promise.resolve(undefined);
        },
        showInformationMessage: (message: string) => {
            messages.push({ type: 'info', message });
            return Promise.resolve(undefined);
        },
        showErrorMessage: (message: string) => {
            messages.push({ type: 'error', message });
            return Promise.resolve(undefined);
        },
        withProgress: async (_options: unknown, task: () => Promise<void>) => {
            await task();
        },
        createStatusBarItem: () => ({
            text: '',
            tooltip: '',
            command: '',
            show: () => {},
            dispose: () => {}
        })
    };

    const workspace = {
        openTextDocument: vi.fn(async (uri: { fsPath: string }) => {
            if (openTextDocumentBehavior) {
                return openTextDocumentBehavior(uri.fsPath);
            }
            return {
                uri,
                lineCount: 1,
                lineAt: () => ({ text: '' })
            };
        }),
        applyEdit: vi.fn(async () => true),
        onDidSaveTextDocument: () => ({ dispose: () => {} })
    };

    const commands = {
        registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
            commandRegistry.set(id, handler);
            return { dispose: () => commandRegistry.delete(id) };
        },
        executeCommand: (id: string, ...args: unknown[]) => {
            if (id === 'setContext') {
                const [key, value] = args as [string, unknown];
                contextValues.set(key, value);
                return undefined;
            }
            const handler = commandRegistry.get(id);
            return handler ? handler(...args) : undefined;
        }
    };

    const languages = {
        registerCodeLensProvider: () => ({ dispose: () => {} }),
        registerHoverProvider: () => ({ dispose: () => {} }),
        getDiagnostics: () => []
    };

    const ProgressLocation = {
        Notification: 1
    };

    return {
        TreeItem,
        ThemeIcon,
        ThemeColor,
        Position,
        Range,
        Selection,
        WorkspaceEdit,
        EventEmitter,
        TextEditorRevealType,
        TreeItemCollapsibleState,
        Uri,
        window,
        workspace,
        commands,
        languages,
        ProgressLocation,
        DiagnosticSeverity: {
            Error: 0,
            Warning: 1,
            Information: 2,
            Hint: 3
        }
    };
});

vi.mock('../config/configManager', () => {
    return {
        ConfigManager: class {
            initialize = vi.fn(async () => {});
            getConfig = vi.fn(() => ({
                git_hooks: {
                    auto_install: false,
                    pre_commit_enabled: false
                },
                ai_review: {
                    enabled: false,
                    api_endpoint: '',
                    api_key: '',
                    timeout: 1000,
                    action: 'warning'
                }
            }));
            dispose = vi.fn(() => {});
        }
    };
});

vi.mock('../core/reviewEngine', () => {
    return {
        ReviewEngine: class {
            constructor() {}
            initialize = vi.fn(async () => {});
            reviewStagedFiles = vi.fn(async () => ({ passed: true, errors: [], warnings: [], info: [] }));
        }
    };
});

vi.mock('../hooks/gitHookManager', () => {
    return {
        GitHookManager: class {
            constructor() {}
            isHookInstalled = vi.fn(async () => true);
            installPreCommitHook = vi.fn(async () => true);
        }
    };
});

vi.mock('../ui/statusBar', () => {
    return {
        StatusBar: class {
            updateStatus = vi.fn(() => {});
            updateWithResult = vi.fn(() => {});
            dispose = vi.fn(() => {});
        }
    };
});

vi.mock('../utils/logger', () => {
    return {
        Logger: class {
            info = vi.fn(() => {});
            warn = vi.fn(() => {});
            error = vi.fn(() => {});
            static setInfoOutputEnabled = vi.fn(() => {});
            static disposeSharedOutputChannel = vi.fn(() => {});
        }
    };
});

vi.mock('../utils/runtimeTraceLogger', () => {
    const runtimeTraceLoggerMock = {
        initialize: vi.fn(async () => {}),
        applyConfig: vi.fn(() => {}),
        shouldOutputInfoToChannel: vi.fn(() => true),
        flushAndCloseAll: vi.fn(async () => {}),
    };
    return {
        RuntimeTraceLogger: class {
            static getInstance = () => runtimeTraceLoggerMock;
        },
    };
});

import { ReviewPanel, ReviewPanelProvider, ReviewTreeItem } from '../ui/reviewPanel';
import { activate } from '../extension';

const createContext = (): import('vscode').ExtensionContext => ({
    subscriptions: [] as Array<{ dispose?: () => void }>,
    extensionPath: 'd:/ext',
    globalStorageUri: { fsPath: 'd:/tmp/agentreview-test-global-storage' }
} as unknown as import('vscode').ExtensionContext);

beforeEach(() => {
    commandRegistry.clear();
    contextValues.clear();
    messages.length = 0;
    lastTreeView = null;
    lastEditor = null;
    openTextDocumentBehavior = null;
    vi.clearAllMocks();
});

describe('Phase3: 左侧面板定位能力', () => {
    it('问题节点应配置打开文件与定位范围', () => {
        const issue = {
            file: 'd:/demo/file.ts',
            line: 3,
            column: 5,
            message: 'test',
            rule: 'rule',
            severity: 'error' as const
        };

        const item = new ReviewTreeItem('问题', 0, issue);

        expect(item.command?.command).toBe('vscode.open');
        expect(Array.isArray(item.command?.arguments)).toBe(true);

        const selection = (item.command?.arguments?.[1] as { selection?: { start: { line: number; character: number } } })
            .selection;
        expect(selection?.start.line).toBe(2);
        expect(selection?.start.character).toBe(4);
    });

    it('选中问题节点后应打开文件并定位到指定行列', async () => {
        openTextDocumentBehavior = async (path: string) => ({
            uri: { fsPath: path },
            lineCount: 3,
            lineAt: () => ({ text: 'const a = 1;' })
        });

        const panel = new ReviewPanel(createContext());
        void panel;
        const issue = {
            file: 'd:/demo/a.ts',
            line: 2,
            column: 4,
            message: 'm',
            rule: 'r',
            severity: 'error' as const
        };
        const item = new ReviewTreeItem('问题', 0, issue);

        lastTreeView?.fireSelection([item]);

        await flushPromises();

        expect(lastEditor?.selection).toBeDefined();
        const selection = lastEditor?.selection as { start: { line: number; character: number } };
        expect(selection.start.line).toBe(1);
        expect(selection.start.character).toBe(3);
    });
});

describe('Phase3: 放行后本地同步与标记', () => {
    it('插入 @ai-ignore 后应本地同步行号并打上已放行标记', async () => {
        const lines = [
            '<template>',
            '  <div class="sample">',
            '    <!-- v-for 缺少 :key -->',
            '    <!-- @ai-ignore: 当前迭代暂不处理 -->',
            '    <li v-for="item in items">{{ item.name }}</li>',
            '    <p v-if="user">{{ user.name }}</p>',
            '  </div>',
            '</template>',
        ];
        openTextDocumentBehavior = async (path: string) => ({
            uri: { fsPath: path },
            lineCount: lines.length,
            lineAt: (index: number) => ({ text: lines[index] ?? '' }),
        });

        const panel = new ReviewPanel(createContext());
        const filePath = 'd:/demo/sample.vue';
        panel.showReviewResult({
            passed: false,
            errors: [],
            warnings: [
                {
                    file: filePath,
                    line: 4,
                    column: 5,
                    message: 'v-for 缺少 :key',
                    rule: 'vue_require_v_for_key',
                    severity: 'warning',
                },
                {
                    file: filePath,
                    line: 4,
                    column: 5,
                    message: '<li> 不应直接作为 <div> 子节点',
                    rule: 'html_li_parent',
                    severity: 'warning',
                },
                {
                    file: filePath,
                    line: 6,
                    column: 22,
                    message: '模板插值存在多余空格',
                    rule: 'template_interp_spacing',
                    severity: 'info',
                },
            ],
            info: [],
        }, 'completed');

        await panel.syncAfterIssueIgnore({
            filePath,
            insertedLine: 4,
        });

        const next = panel.getCurrentResult();
        expect(next).not.toBeNull();
        const issues = next?.warnings ?? [];
        expect(issues.length).toBe(3);
        expect(issues[0].line).toBe(5);
        expect(issues[0].ignored).toBe(true);
        expect(issues[0].ignoreReason).toBe('当前迭代暂不处理');
        expect(issues[1].line).toBe(5);
        expect(issues[1].ignored).toBe(true);
        expect(issues[2].line).toBe(7);
        expect(issues[2].ignored).toBe(false);
    });

    it('TreeView 问题节点应展示“已放行”前缀', () => {
        const provider = new ReviewPanelProvider(createContext());
        const filePath = 'd:/demo/sample.vue';
        provider.updateResult({
            passed: false,
            errors: [],
            warnings: [
                {
                    file: filePath,
                    line: 5,
                    column: 3,
                    message: 'v-for 缺少 :key',
                    rule: 'vue_require_v_for_key',
                    severity: 'warning',
                    ignored: true,
                    ignoreReason: '当前迭代暂不处理',
                },
            ],
            info: [],
        }, 'completed');

        const rootItems = provider.getChildren();
        const existingGroup = rootItems.find(item => item.groupKey === 'existing');
        expect(existingGroup).toBeDefined();
        const fileItems = provider.getChildren(existingGroup);
        expect(fileItems.length).toBe(1);
        const issueItems = provider.getChildren(fileItems[0]);
        expect(issueItems.length).toBe(1);
        expect(String(issueItems[0].label).startsWith('【已放行】')).toBe(true);
        expect(typeof issueItems[0].description === 'string' && issueItems[0].description.includes('已放行')).toBe(true);
    });
});

describe('Phase3: 左侧面板选中高亮', () => {
    it('连续选择两个问题节点，高亮应更新并清理旧高亮', async () => {
        openTextDocumentBehavior = async (path: string) => ({
            uri: { fsPath: path },
            lineCount: 2,
            lineAt: () => ({ text: 'const a = 1;' })
        });

        const panel = new ReviewPanel(createContext());
        void panel;
        const firstIssue = {
            file: 'd:/demo/a.ts',
            line: 1,
            column: 1,
            message: 'm1',
            rule: 'r',
            severity: 'error' as const
        };
        const secondIssue = {
            file: 'd:/demo/b.ts',
            line: 1,
            column: 1,
            message: 'm2',
            rule: 'r',
            severity: 'warning' as const
        };

        lastTreeView?.fireSelection([new ReviewTreeItem('问题', 0, firstIssue)]);
        await flushPromises();
        const firstEditor = lastEditor;

        lastTreeView?.fireSelection([new ReviewTreeItem('问题', 0, secondIssue)]);
        await flushPromises();

        const vscode = await import('vscode');
        const openTextDocumentMock = vscode.workspace.openTextDocument as unknown as ReturnType<typeof vi.fn>;
        expect(openTextDocumentMock).toHaveBeenCalledTimes(2);
        expect(firstEditor?.decorationCalls.some(call => call.ranges.length === 0)).toBe(true);
    });

    it('选中文件节点或状态节点时不触发高亮', async () => {
        openTextDocumentBehavior = async (path: string) => ({
            uri: { fsPath: path },
            lineCount: 1,
            lineAt: () => ({ text: 'const a = 1;' })
        });

        const panel = new ReviewPanel(createContext());
        void panel;
        const issue = {
            file: 'd:/demo/a.ts',
            line: 1,
            column: 1,
            message: 'm',
            rule: 'r',
            severity: 'error' as const
        };

        lastTreeView?.fireSelection([new ReviewTreeItem('问题', 0, issue)]);
        await flushPromises();
        const editorAfterIssue = lastEditor;

        lastTreeView?.fireSelection([new ReviewTreeItem('文件', 1, undefined, 'd:/demo/a.ts')]);
        await flushPromises();

        expect(editorAfterIssue?.decorationCalls.some(call => call.ranges.length === 0)).toBe(true);
    });

    it('文件不存在或路径无效时提示并跳过', async () => {
        openTextDocumentBehavior = async () => {
            throw new Error('not found');
        };

        const panel = new ReviewPanel(createContext());
        void panel;
        const issue = {
            file: 'd:/demo/missing.ts',
            line: 1,
            column: 1,
            message: 'm',
            rule: 'r',
            severity: 'error' as const
        };

        lastTreeView?.fireSelection([new ReviewTreeItem('问题', 0, issue)]);
        await flushPromises();

        expect(messages.some(message => message.type === 'warning' && message.message.includes('无法打开文件'))).toBe(true);
    });

    it('行列越界时安全降级', async () => {
        openTextDocumentBehavior = async (path: string) => ({
            uri: { fsPath: path },
            lineCount: 1,
            lineAt: () => ({ text: 'abc' })
        });

        const panel = new ReviewPanel(createContext());
        void panel;
        const issue = {
            file: 'd:/demo/a.ts',
            line: 99,
            column: 99,
            message: 'm',
            rule: 'r',
            severity: 'info' as const
        };

        lastTreeView?.fireSelection([new ReviewTreeItem('问题', 0, issue)]);
        await flushPromises();

        const selection = lastEditor?.selection as { start: { line: number; character: number } };
        expect(selection.start.line).toBe(0);
        expect(selection.start.character).toBe(3);
    });
});

describe('Phase3: 命令与菜单注册', () => {
    it('新命令在激活时注册', async () => {
        const context = createContext();
        await activate(context as never);

        expect(commandRegistry.has('agentreview.run')).toBe(true);
        expect(commandRegistry.has('agentreview.review')).toBe(true);
        expect(commandRegistry.has('agentreview.showReport')).toBe(true);
        expect(commandRegistry.has('agentreview.installHooks')).toBe(true);
        expect(commandRegistry.has('agentreview.refresh')).toBe(true);
        expect(commandRegistry.has('agentreview.allowIssueIgnore')).toBe(true);
    });

    it('TreeView 菜单仅对问题节点生效', () => {
        const issue = {
            file: 'd:/demo/a.ts',
            line: 1,
            column: 1,
            message: 'm',
            rule: 'r',
            severity: 'warning' as const
        };
        const issueItem = new ReviewTreeItem('问题', 0, issue);
        const fileItem = new ReviewTreeItem('文件', 1, undefined, 'd:/demo/a.ts');
        const statusItem = new ReviewTreeItem('状态', 0);

        expect(issueItem.contextValue).toBe('reviewIssue');
        expect(fileItem.contextValue).toBe('reviewFile');
        expect(statusItem.contextValue).toBeUndefined();
    });
});
