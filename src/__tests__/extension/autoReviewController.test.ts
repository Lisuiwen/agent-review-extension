import { createHash } from 'crypto';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createContentHash = (content: string): string =>
    createHash('sha1').update(content, 'utf8').digest('hex');

const mocked = vi.hoisted(() => {
    const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();
    const saveListeners: Array<(doc: any) => void> = [];
    const changeListeners: Array<(event: any) => void> = [];
    const messages: Array<{ type: 'info' | 'warning' | 'error'; message: string }> = [];
    const reviewSavedFileWithPendingDiffContextMock = vi.fn(async () => ({
        result: { passed: true, errors: [], warnings: [], info: [] },
        reviewedRanges: [],
        mode: 'full' as const,
        reason: 'fallback_full' as const,
    }));
    const applyFileReviewPatchMock = vi.fn();
    const clearFileStaleMarkersMock = vi.fn();
    const runtimeFlushMock = vi.fn(async () => {});
    const configDisposeMock = vi.fn();
    const panelDisposeMock = vi.fn();
    const statusDisposeMock = vi.fn();
    const isFileStaleMock = vi.fn(() => true);
    const getPendingDiffMock = vi.fn(async () => new Map());
    const evaluateAutoReviewGateMock = vi.fn(() => ({
        skip: false,
        effectiveChangedLines: 1,
        riskMatched: false,
    }));
    let activeTextEditor: any = null;
    let visibleTextEditors: any[] = [];
    let mockConfig: any = {
        ai_review: {
            enabled: false,
            run_on_save: false,
            run_on_save_debounce_ms: 0,
            run_on_save_max_runs_per_minute: 4,
            idle_recheck_enabled: false,
            idle_recheck_ms: 200,
            large_change_line_threshold: 40,
            review_current_file_now_bypass_rate_limit: false,
            action: 'warning',
            timeout: 1000,
            api_endpoint: '',
            api_key: '',
        },
        runtime_log: {},
    };

    return {
        commandRegistry,
        saveListeners,
        changeListeners,
        messages,
        reviewSavedFileWithPendingDiffContextMock,
        applyFileReviewPatchMock,
        clearFileStaleMarkersMock,
        runtimeFlushMock,
        configDisposeMock,
        panelDisposeMock,
        statusDisposeMock,
        isFileStaleMock,
        getPendingDiffMock,
        evaluateAutoReviewGateMock,
        get activeTextEditor() {
            return activeTextEditor;
        },
        set activeTextEditor(value: any) {
            activeTextEditor = value;
        },
        get visibleTextEditors() {
            return visibleTextEditors;
        },
        set visibleTextEditors(value: any[]) {
            visibleTextEditors = value;
        },
        get mockConfig() {
            return mockConfig;
        },
        set mockConfig(value: any) {
            mockConfig = value;
        },
    };
});

vi.mock('vscode', () => {
    class Position {
        line: number;
        character: number;
        constructor(line: number, character: number) {
            this.line = line;
            this.character = character;
        }
    }
    class Location {
        uri: any;
        range: any;
        constructor(uri: any, range: any) {
            this.uri = uri;
            this.range = range;
        }
    }
    const commands = {
        registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
            mocked.commandRegistry.set(id, handler);
            return { dispose: () => mocked.commandRegistry.delete(id) };
        },
        executeCommand: (id: string, ...args: unknown[]) => {
            const handler = mocked.commandRegistry.get(id);
            if (handler) return handler(...args);
            return undefined;
        },
    };
    const window = {
        get activeTextEditor() {
            return mocked.activeTextEditor;
        },
        get visibleTextEditors() {
            return mocked.visibleTextEditors;
        },
        showInformationMessage: (message: string) => {
            mocked.messages.push({ type: 'info', message });
            return Promise.resolve(undefined);
        },
        showWarningMessage: (message: string) => {
            mocked.messages.push({ type: 'warning', message });
            return Promise.resolve(undefined);
        },
        showErrorMessage: (message: string) => {
            mocked.messages.push({ type: 'error', message });
            return Promise.resolve(undefined);
        },
        withProgress: async (_options: unknown, task: () => Promise<void>) => task(),
    };
    const workspace = {
        workspaceFolders: [{ uri: { fsPath: 'd:/ws' } }],
        onDidSaveTextDocument: (listener: (doc: any) => void) => {
            mocked.saveListeners.push(listener);
            return { dispose: () => {} };
        },
        onDidChangeTextDocument: (listener: (event: any) => void) => {
            mocked.changeListeners.push(listener);
            return { dispose: () => {} };
        },
    };
    return {
        commands,
        window,
        workspace,
        Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
        Position,
        Location,
        ProgressLocation: { Notification: 1 },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        languages: {
            getDiagnostics: () => [],
        },
    };
});

vi.mock('../../config/configManager', () => ({
    ConfigManager: class {
        initialize = vi.fn(async () => {});
        getConfig = vi.fn(() => mocked.mockConfig);
        dispose = mocked.configDisposeMock;
    },
}));

vi.mock('../../core/reviewEngine', () => ({
    ReviewEngine: class {
        initialize = vi.fn(async () => {});
        reviewSavedFileWithPendingDiffContext = mocked.reviewSavedFileWithPendingDiffContextMock;
        reviewPendingChanges = vi.fn(async () => ({ passed: true, errors: [], warnings: [], info: [] }));
        reviewStagedFiles = vi.fn(async () => ({ passed: true, errors: [], warnings: [], info: [] }));
    },
}));

vi.mock('../../ui/reviewPanel', () => ({
    ReviewPanel: class {
        configureLocalRebase = vi.fn();
        setStatus = vi.fn();
        setSubStatus = vi.fn();
        getCurrentResult = vi.fn(() => ({ passed: true, errors: [], warnings: [], info: [] }));
        isFileStale = mocked.isFileStaleMock;
        clearFileStaleMarkers = mocked.clearFileStaleMarkersMock;
        applyFileReviewPatch = mocked.applyFileReviewPatchMock;
        dispose = mocked.panelDisposeMock;
    },
}));

vi.mock('../../ui/statusBar', () => ({
    StatusBar: class {
        updateStatus = vi.fn();
        updateWithResult = vi.fn();
        dispose = mocked.statusDisposeMock;
    },
}));

vi.mock('../../utils/logger', () => ({
    Logger: class {
        info = vi.fn();
        important = vi.fn();
        warn = vi.fn();
        error = vi.fn();
        static setInfoOutputEnabled = vi.fn();
        static disposeSharedOutputChannel = vi.fn();
    },
}));

vi.mock('../../utils/fileScanner', () => ({
    FileScanner: class {
        getPendingDiff = mocked.getPendingDiffMock;
    },
}));

vi.mock('../../utils/runtimeTraceLogger', () => ({
    RuntimeTraceLogger: class {
        static getInstance = () => ({
            initialize: vi.fn(async () => {}),
            shouldOutputInfoToChannel: vi.fn(() => false),
            flushAndCloseAll: mocked.runtimeFlushMock,
        });
    },
}));

vi.mock('../../utils/runtimeLogPath', () => ({
    resolveRuntimeLogBaseDir: () => 'd:/ws/.runtime',
}));

vi.mock('../../core/autoReviewGate', () => ({
    DEFAULT_RUN_ON_SAVE_RISK_PATTERNS: ['danger'],
    evaluateAutoReviewGate: mocked.evaluateAutoReviewGateMock,
}));

vi.mock('../../commands/runReviewCommand', () => ({ registerRunReviewCommand: () => ({ dispose: () => {} }) }));
vi.mock('../../commands/runStagedReviewCommand', () => ({ registerRunStagedReviewCommand: () => ({ dispose: () => {} }) }));
vi.mock('../../commands/reviewCommand', () => ({ registerReviewCommand: () => ({ dispose: () => {} }) }));
vi.mock('../../commands/showReportCommand', () => ({ registerShowReportCommand: () => ({ dispose: () => {} }) }));
vi.mock('../../commands/refreshCommand', () => ({ registerRefreshCommand: () => ({ dispose: () => {} }) }));
vi.mock('../../commands/allowIssueIgnoreCommand', () => ({ registerAllowIssueIgnoreCommand: () => ({ dispose: () => {} }) }));
vi.mock('../../commands/ignoreIssueCommand', () => ({ registerIgnoreIssueCommand: () => ({ dispose: () => {} }) }));
vi.mock('../../commands/explainRuntimeLogCommand', () => ({ registerExplainRuntimeLogCommand: () => ({ dispose: () => {} }) }));

import { activate, deactivate } from '../../extension';

const flushPromises = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
};

const createContext = (overrides?: Record<string, unknown>) =>
    ({
        subscriptions: [] as Array<{ dispose?: () => void }>,
        extensionPath: 'd:/ext',
        globalStorageUri: { fsPath: 'd:/tmp/ar' },
        ...overrides,
    }) as any;

describe('autoReviewController', () => {
    beforeEach(() => {
        vi.useRealTimers();
        mocked.commandRegistry.clear();
        mocked.saveListeners.length = 0;
        mocked.changeListeners.length = 0;
        mocked.messages.length = 0;
        mocked.reviewSavedFileWithPendingDiffContextMock.mockReset();
        mocked.reviewSavedFileWithPendingDiffContextMock.mockResolvedValue({
            result: { passed: true, errors: [], warnings: [], info: [] },
            reviewedRanges: [],
            mode: 'full',
            reason: 'fallback_full',
        });
        mocked.applyFileReviewPatchMock.mockReset();
        mocked.clearFileStaleMarkersMock.mockReset();
        mocked.runtimeFlushMock.mockReset();
        mocked.isFileStaleMock.mockReset();
        mocked.isFileStaleMock.mockReturnValue(true);
        mocked.getPendingDiffMock.mockReset();
        mocked.getPendingDiffMock.mockResolvedValue(new Map());
        mocked.evaluateAutoReviewGateMock.mockReset();
        mocked.evaluateAutoReviewGateMock.mockReturnValue({
            skip: false,
            effectiveChangedLines: 1,
            riskMatched: false,
        });
        mocked.activeTextEditor = null;
        mocked.visibleTextEditors = [];
        mocked.mockConfig = {
            ai_review: {
                enabled: false,
                run_on_save: false,
                run_on_save_debounce_ms: 0,
                run_on_save_max_runs_per_minute: 4,
                idle_recheck_enabled: false,
                idle_recheck_ms: 200,
                large_change_line_threshold: 40,
                review_current_file_now_bypass_rate_limit: false,
                action: 'warning',
                timeout: 1000,
                api_endpoint: '',
                api_key: '',
            },
            runtime_log: {},
        };
    });

    afterEach(async () => {
        await deactivate();
    });

    it('save 前置门控：非 file 或 AI/save 开关关闭时不入队', async () => {
        await activate(createContext());
        mocked.saveListeners.forEach(listener =>
            listener({ uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, getText: () => 'const a=1;' })
        );
        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: { ...mocked.mockConfig.ai_review, enabled: true, run_on_save: true },
        };
        mocked.saveListeners.forEach(listener =>
            listener({ uri: { scheme: 'untitled', fsPath: 'd:/ws/a.ts' }, getText: () => 'const a=1;' })
        );

        await flushPromises();
        expect(mocked.reviewSavedFileWithPendingDiffContextMock).not.toHaveBeenCalled();
    });

    it('manual 触发前置：无编辑器/未保存/AI 未启用时应提示，满足条件后入队', async () => {
        await activate(createContext());
        const runNow = mocked.commandRegistry.get('agentreview.reviewCurrentFileNow');
        expect(runNow).toBeDefined();

        await runNow!();
        expect(mocked.messages.some(x => x.type === 'info')).toBe(true);

        mocked.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, isDirty: true } };
        await runNow!();
        expect(mocked.messages.some(x => x.type === 'warning')).toBe(true);

        mocked.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, isDirty: false } };
        await runNow!();
        expect(mocked.reviewSavedFileWithPendingDiffContextMock).not.toHaveBeenCalled();

        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: { ...mocked.mockConfig.ai_review, enabled: true },
        };
        await runNow!();
        await flushPromises();
        expect(mocked.reviewSavedFileWithPendingDiffContextMock).toHaveBeenCalledTimes(1);
    });

    it('idle 触发：仅在可见+非 dirty+stale 时触发', async () => {
        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: {
                ...mocked.mockConfig.ai_review,
                enabled: true,
                idle_recheck_enabled: true,
                idle_recheck_ms: 300,
                large_change_line_threshold: 20,
            },
        };
        await activate(createContext());
        mocked.visibleTextEditors = [{ document: { uri: { fsPath: 'd:\\ws\\a.ts' }, isDirty: false } }];
        mocked.isFileStaleMock.mockReturnValue(true);

        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, getText: () => 'const a=1;' },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'x' }],
            })
        );

        await new Promise(resolve => setTimeout(resolve, 350));
        await flushPromises();
        expect(mocked.reviewSavedFileWithPendingDiffContextMock).toHaveBeenCalledTimes(1);
    });

    it('结果过期时应丢弃旧结果，不更新面板 patch', async () => {
        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: {
                ...mocked.mockConfig.ai_review,
                enabled: true,
                run_on_save: true,
                run_on_save_debounce_ms: 0,
            },
        };
        let resolveFirst: ((value: any) => void) | null = null;
        const firstPromise = new Promise(resolve => {
            resolveFirst = resolve;
        });
        mocked.reviewSavedFileWithPendingDiffContextMock
            .mockImplementationOnce(() => firstPromise as any)
            .mockResolvedValue({
                result: { passed: true, errors: [], warnings: [], info: [] },
                reviewedRanges: [],
                mode: 'full',
                reason: 'fallback_full',
            });

        await activate(createContext());
        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, getText: () => 'const v=1;' },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'v1' }],
            })
        );
        mocked.saveListeners.forEach(listener =>
            listener({ uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, getText: () => 'const v=1;' })
        );
        await flushPromises();

        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, getText: () => 'const v=2;' },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'v2' }],
            })
        );
        mocked.saveListeners.forEach(listener =>
            listener({ uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, getText: () => 'const v=2;' })
        );

        (resolveFirst as ((value: unknown) => void) | null)?.({
            result: { passed: true, errors: [], warnings: [], info: [] },
            reviewedRanges: [],
            mode: 'full',
            reason: 'fallback_full',
        });
        await flushPromises();
        await flushPromises();

        expect(mocked.reviewSavedFileWithPendingDiffContextMock).toHaveBeenCalledTimes(2);
        expect(mocked.applyFileReviewPatchMock).toHaveBeenCalledTimes(1);
    });

    it('内容 hash 回滚到 lastReviewed 时应清除 stale 标记', async () => {
        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: {
                ...mocked.mockConfig.ai_review,
                enabled: true,
                run_on_save: true,
                run_on_save_debounce_ms: 0,
            },
        };
        await activate(createContext());

        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, getText: () => 'const same=1;' },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'same' }],
            })
        );
        mocked.saveListeners.forEach(listener =>
            listener({ uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, getText: () => 'const same=1;' })
        );
        await flushPromises();

        mocked.clearFileStaleMarkersMock.mockClear();
        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: 'd:/ws/a.ts' }, getText: () => 'const same=1;' },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'same' }],
            })
        );

        expect(mocked.clearFileStaleMarkersMock).toHaveBeenCalledWith('d:\\ws\\a.ts');
    });

    it('deactivate 应释放并 flush runtime logger', async () => {
        await activate(createContext());
        await deactivate();

        expect(mocked.panelDisposeMock).toHaveBeenCalled();
        expect(mocked.statusDisposeMock).toHaveBeenCalled();
        expect(mocked.configDisposeMock).toHaveBeenCalled();
        expect(mocked.runtimeFlushMock).toHaveBeenCalled();
    });

    // --- manual-review-store-hash: manual/idle 使用 reviewedContentHash 更新 lastReviewedContentHash ---

    it('1.1 manual 任务完成时使用 reviewedContentHash 更新 lastReviewedContentHash', async () => {
        const content = 'const manual=1;';
        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: { ...mocked.mockConfig.ai_review, enabled: true },
        };
        mocked.activeTextEditor = {
            document: {
                uri: { scheme: 'file', fsPath: 'd:/ws/manual.ts' },
                isDirty: false,
                getText: () => content,
            },
        };
        await activate(createContext());
        const runNow = mocked.commandRegistry.get('agentreview.reviewCurrentFileNow');
        await runNow!();
        await flushPromises();
        expect(mocked.reviewSavedFileWithPendingDiffContextMock).toHaveBeenCalledTimes(1);

        mocked.clearFileStaleMarkersMock.mockClear();
        mocked.changeListeners.forEach(listener =>
            listener({
                document: {
                    uri: { scheme: 'file', fsPath: 'd:/ws/manual.ts' },
                    getText: () => content,
                },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'x' }],
            })
        );
        expect(mocked.clearFileStaleMarkersMock).toHaveBeenCalledWith('d:\\ws\\manual.ts');
    });

    it('1.2 idle 任务完成时使用 reviewedContentHash 更新 lastReviewedContentHash', async () => {
        const content = 'const idle=1;';
        const changePath = 'd:/ws/a.ts';
        const visiblePath = 'd:\\ws\\a.ts';
        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: {
                ...mocked.mockConfig.ai_review,
                enabled: true,
                idle_recheck_enabled: true,
                idle_recheck_ms: 300,
                large_change_line_threshold: 20,
            },
        };
        await activate(createContext());
        mocked.visibleTextEditors = [
            {
                document: {
                    uri: { scheme: 'file', fsPath: visiblePath },
                    isDirty: false,
                    getText: () => content,
                },
            },
        ];
        mocked.isFileStaleMock.mockReturnValue(true);
        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: changePath }, getText: () => content },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'x' }],
            })
        );
        await new Promise(resolve => setTimeout(resolve, 350));
        await flushPromises();
        await flushPromises();
        expect(mocked.reviewSavedFileWithPendingDiffContextMock).toHaveBeenCalledTimes(1);

        mocked.clearFileStaleMarkersMock.mockClear();
        mocked.changeListeners.forEach(listener =>
            listener({
                document: {
                    uri: { scheme: 'file', fsPath: changePath },
                    getText: () => content,
                },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'y' }],
            })
        );
        expect(mocked.clearFileStaleMarkersMock).toHaveBeenCalledWith(path.normalize(changePath));
    });

    it('1.3 save 任务完成时仅用 savedContentHash 更新，不受 reviewedContentHash 影响', async () => {
        const content = 'const saveOnly=1;';
        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: {
                ...mocked.mockConfig.ai_review,
                enabled: true,
                run_on_save: true,
                run_on_save_debounce_ms: 0,
            },
        };
        await activate(createContext());
        mocked.saveListeners.forEach(listener =>
            listener({
                uri: { scheme: 'file', fsPath: 'd:/ws/saveOnly.ts' },
                getText: () => content,
            })
        );
        await flushPromises();
        expect(mocked.reviewSavedFileWithPendingDiffContextMock).toHaveBeenCalledTimes(1);

        mocked.clearFileStaleMarkersMock.mockClear();
        mocked.changeListeners.forEach(listener =>
            listener({
                document: {
                    uri: { scheme: 'file', fsPath: 'd:/ws/saveOnly.ts' },
                    getText: () => content,
                },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'z' }],
            })
        );
        expect(mocked.clearFileStaleMarkersMock).toHaveBeenCalledWith('d:\\ws\\saveOnly.ts');
    });

    it('1.4 手动入队时任务带上 reviewedContentHash（等于当前文档内容哈希）', async () => {
        const content = 'const hashMe=42;';
        const expectedHash = createContentHash(content);
        const captured: Array<{ path: string; task: { reviewedContentHash?: string | null } }> = [];
        const ctx = createContext();
        (ctx as any).__agentReviewCaptureEnqueue = (path: string, task: any) => {
            captured.push({ path, task });
        };
        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: { ...mocked.mockConfig.ai_review, enabled: true },
        };
        mocked.activeTextEditor = {
            document: {
                uri: { scheme: 'file', fsPath: 'd:/ws/hashMe.ts' },
                isDirty: false,
                getText: () => content,
            },
        };
        await activate(ctx);
        const runNow = mocked.commandRegistry.get('agentreview.reviewCurrentFileNow');
        await runNow!();
        expect(captured.length).toBeGreaterThanOrEqual(1);
        expect(captured[0].task.reviewedContentHash).toBe(expectedHash);
    });

    it('1.5 当 lastReviewedContentHash 已设且文档变更内容哈希与之相等时 clearFileStaleMarkers 被调用', async () => {
        const content = 'const same=1;';
        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: {
                ...mocked.mockConfig.ai_review,
                enabled: true,
                run_on_save: true,
                run_on_save_debounce_ms: 0,
            },
        };
        await activate(createContext());
        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: 'd:/ws/same.ts' }, getText: () => content },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'a' }],
            })
        );
        mocked.saveListeners.forEach(listener =>
            listener({ uri: { scheme: 'file', fsPath: 'd:/ws/same.ts' }, getText: () => content })
        );
        await flushPromises();
        mocked.clearFileStaleMarkersMock.mockClear();
        mocked.changeListeners.forEach(listener =>
            listener({
                document: {
                    uri: { scheme: 'file', fsPath: 'd:/ws/same.ts' },
                    getText: () => content,
                },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'b' }],
            })
        );
        expect(mocked.clearFileStaleMarkersMock).toHaveBeenCalledWith('d:\\ws\\same.ts');
    });
    it('2.4 run 路径下编辑后撤销未保存改动可触发 clearFileStaleMarkers', async () => {
        let persistFn: ((path: string, hash: string) => void) | null = null;
        const ctx = createContext({
            __agentReviewCapturePersist: (fn: (path: string, hash: string) => void) => { persistFn = fn; },
        });
        await activate(ctx);
        expect(persistFn).not.toBeNull();

        const content = 'const runUndo = 1;';
        const filePath = 'd:/ws/run-undo.ts';
        persistFn!(filePath, createContentHash(content));

        mocked.clearFileStaleMarkersMock.mockClear();
        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: filePath }, getText: () => content },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'x' }],
            })
        );
        expect(mocked.clearFileStaleMarkersMock).toHaveBeenCalledWith(path.normalize(filePath));
    });

    it('2.5 runStaged 路径下编辑后撤销未保存改动可触发 clearFileStaleMarkers', async () => {
        let persistFn: ((path: string, hash: string) => void) | null = null;
        const ctx = createContext({
            __agentReviewCapturePersist: (fn: (path: string, hash: string) => void) => { persistFn = fn; },
        });
        await activate(ctx);
        expect(persistFn).not.toBeNull();

        const content = 'const stagedUndo = 1;';
        const filePath = 'd:/ws/staged-undo.ts';
        persistFn!(filePath, createContentHash(content));

        mocked.clearFileStaleMarkersMock.mockClear();
        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: filePath }, getText: () => content },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'y' }],
            })
        );
        expect(mocked.clearFileStaleMarkersMock).toHaveBeenCalledWith(path.normalize(filePath));
    });

    it('stale dropped result should not persist lastReviewedContentHash', async () => {
        mocked.mockConfig = {
            ...mocked.mockConfig,
            ai_review: {
                ...mocked.mockConfig.ai_review,
                enabled: true,
                run_on_save: true,
                run_on_save_debounce_ms: 0,
            },
        };
        let resolveFirst: ((value: any) => void) | null = null;
        mocked.reviewSavedFileWithPendingDiffContextMock.mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    resolveFirst = resolve;
                }) as any
        );

        await activate(createContext());
        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: 'd:/ws/stale-hash.ts' }, getText: () => 'const v=1;' },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'v1' }],
            })
        );
        mocked.saveListeners.forEach(listener =>
            listener({ uri: { scheme: 'file', fsPath: 'd:/ws/stale-hash.ts' }, getText: () => 'const v=1;' })
        );
        await flushPromises();

        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: 'd:/ws/stale-hash.ts' }, getText: () => 'const v=2;' },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'v2' }],
            })
        );

        (resolveFirst as ((value: unknown) => void) | null)?.({
            result: { passed: true, errors: [], warnings: [], info: [] },
            reviewedRanges: [],
            mode: 'full',
            reason: 'fallback_full',
        });
        await flushPromises();
        await flushPromises();

        mocked.clearFileStaleMarkersMock.mockClear();
        mocked.changeListeners.forEach(listener =>
            listener({
                document: { uri: { scheme: 'file', fsPath: 'd:/ws/stale-hash.ts' }, getText: () => 'const v=1;' },
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'back' }],
            })
        );
        expect(mocked.clearFileStaleMarkersMock).not.toHaveBeenCalled();
    });
});


