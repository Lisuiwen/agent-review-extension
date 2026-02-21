import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupConfigWatcher } from '../../config/configWatcher';

const mocked = vi.hoisted(() => {
    const watchers: any[] = [];
    return { watchers };
});

vi.mock('vscode', () => {
    class RelativePattern {
        workspaceFolder: unknown;
        pattern: string;
        constructor(workspaceFolder: unknown, pattern: string) {
            this.workspaceFolder = workspaceFolder;
            this.pattern = pattern;
        }
    }

    const createWatcher = () => {
        let onChange: (() => void) | undefined;
        let onCreate: (() => void) | undefined;
        let onDelete: (() => void) | undefined;
        const watcher = {
            onDidChange: (cb: () => void) => {
                onChange = cb;
                return { dispose: () => {} };
            },
            onDidCreate: (cb: () => void) => {
                onCreate = cb;
                return { dispose: () => {} };
            },
            onDidDelete: (cb: () => void) => {
                onDelete = cb;
                return { dispose: () => {} };
            },
            fireChange: () => onChange?.(),
            fireCreate: () => onCreate?.(),
            fireDelete: () => onDelete?.(),
            dispose: vi.fn(),
        };
        mocked.watchers.push(watcher);
        return watcher;
    };

    return {
        workspace: {
            createFileSystemWatcher: vi.fn(() => createWatcher()),
        },
        RelativePattern,
    };
});

describe('configWatcher', () => {
    beforeEach(() => {
        mocked.watchers.length = 0;
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    it('防抖应合并多次事件，仅触发一次 onReload', async () => {
        const onReload = vi.fn();
        const disposable = setupConfigWatcher(
            { uri: { fsPath: 'd:/ws' }, name: 'ws', index: 0 } as any,
            'd:/ws/.agentreview.yaml',
            'd:/ws/.env',
            onReload,
            50
        );

        expect(mocked.watchers).toHaveLength(2);
        const [configWatcher, envWatcher] = mocked.watchers;

        configWatcher.fireChange();
        configWatcher.fireCreate();
        envWatcher.fireDelete();
        vi.advanceTimersByTime(49);
        expect(onReload).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        await Promise.resolve();
        expect(onReload).toHaveBeenCalledTimes(1);

        disposable.dispose();
    });

    it('dispose 应清理 timer 并释放两个 watcher', () => {
        const onReload = vi.fn();
        const disposable = setupConfigWatcher(
            { uri: { fsPath: 'd:/ws' }, name: 'ws', index: 0 } as any,
            'd:/ws/.agentreview.yaml',
            'd:/ws/.env',
            onReload,
            100
        );
        const [configWatcher, envWatcher] = mocked.watchers;
        configWatcher.fireChange();

        disposable.dispose();
        vi.advanceTimersByTime(150);

        expect(onReload).not.toHaveBeenCalled();
        expect(configWatcher.dispose).toHaveBeenCalledTimes(1);
        expect(envWatcher.dispose).toHaveBeenCalledTimes(1);
    });
});
