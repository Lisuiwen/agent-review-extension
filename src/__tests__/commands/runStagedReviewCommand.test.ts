import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerRunStagedReviewCommand } from '../../commands/runStagedReviewCommand';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('vscode', () => ({
    commands: {
        registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(id, handler);
            return { dispose: () => handlers.delete(id) };
        },
    },
    window: {
        withProgress: vi.fn(async (_options: unknown, task: () => Promise<void>) => task()),
        showErrorMessage: vi.fn(),
    },
}));

describe('runStagedReviewCommand', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        handlers.clear();
    });

    it('组件未初始化时应提示错误并返回', async () => {
        const logger = { info: vi.fn(), error: vi.fn() };
        registerRunStagedReviewCommand({
            reviewEngine: undefined,
            configManager: undefined,
            reviewPanel: undefined,
            statusBar: undefined,
            logger,
            getGitRoot: () => null,
        } as any);

        const handler = handlers.get('agentreview.runStaged');
        expect(handler).toBeDefined();
        await handler!();

        expect(logger.error).toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it('成功路径应调用 staged 审查并更新 UI', async () => {
        const result = {
            passed: false,
            errors: [{ file: 'a.ts', line: 1, column: 1, message: 'e', rule: 'r', severity: 'error' }],
            warnings: [],
            info: [],
        };
        const reviewEngine = { reviewStagedFiles: vi.fn(async () => result) };
        const reviewPanel = {
            setStatus: vi.fn(),
            reveal: vi.fn(),
            showReviewResult: vi.fn(),
        };
        const statusBar = {
            updateStatus: vi.fn(),
            updateWithResult: vi.fn(),
        };
        const logger = { info: vi.fn(), error: vi.fn() };

        registerRunStagedReviewCommand({
            reviewEngine,
            configManager: undefined,
            reviewPanel,
            statusBar,
            logger,
            getGitRoot: () => null,
        } as any);

        const handler = handlers.get('agentreview.runStaged');
        await handler!();

        expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
        expect(statusBar.updateStatus).toHaveBeenCalledWith('reviewing');
        expect(reviewPanel.setStatus).toHaveBeenCalledWith('reviewing');
        expect(reviewPanel.reveal).toHaveBeenCalledTimes(1);
        expect(reviewEngine.reviewStagedFiles).toHaveBeenCalledTimes(1);
        expect(reviewPanel.showReviewResult).toHaveBeenCalledWith(result, 'completed', '', '没有staged文件需要审查');
        expect(statusBar.updateWithResult).toHaveBeenCalledWith(result);
    });

    it('异常路径应设置错误状态并提示', async () => {
        const reviewEngine = { reviewStagedFiles: vi.fn(async () => { throw new Error('boom'); }) };
        const reviewPanel = {
            setStatus: vi.fn(),
            reveal: vi.fn(),
            showReviewResult: vi.fn(),
        };
        const statusBar = {
            updateStatus: vi.fn(),
            updateWithResult: vi.fn(),
        };
        const logger = { info: vi.fn(), error: vi.fn() };

        registerRunStagedReviewCommand({
            reviewEngine,
            configManager: undefined,
            reviewPanel,
            statusBar,
            logger,
            getGitRoot: () => null,
        } as any);

        const handler = handlers.get('agentreview.runStaged');
        await handler!();

        expect(logger.error).toHaveBeenCalled();
        expect(statusBar.updateStatus).toHaveBeenCalledWith('error');
        expect(reviewPanel.setStatus).toHaveBeenCalledWith('error');
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('staged 审查失败，请查看输出日志');
    });
});
