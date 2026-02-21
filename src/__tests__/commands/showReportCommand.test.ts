import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerShowReportCommand } from '../../commands/showReportCommand';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('vscode', () => ({
    commands: {
        registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(id, handler);
            return { dispose: () => handlers.delete(id) };
        },
    },
    window: {
        showInformationMessage: vi.fn(),
    },
}));

describe('showReportCommand', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        handlers.clear();
    });

    it('存在 panel 时应调用 reveal', async () => {
        const reveal = vi.fn();
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        registerShowReportCommand({
            reviewEngine: undefined,
            configManager: undefined,
            reviewPanel: { reveal },
            statusBar: undefined,
            logger,
            getGitRoot: () => null,
        } as any);

        const handler = handlers.get('agentreview.showReport');
        expect(handler).toBeDefined();
        await handler!();

        expect(reveal).toHaveBeenCalledTimes(1);
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('不存在 panel 时应提示信息', async () => {
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        registerShowReportCommand({
            reviewEngine: undefined,
            configManager: undefined,
            reviewPanel: undefined,
            statusBar: undefined,
            logger,
            getGitRoot: () => null,
        } as any);

        const handler = handlers.get('agentreview.showReport');
        await handler!();

        expect(logger.warn).toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('审查面板未初始化');
    });
});
