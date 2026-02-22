import * as path from 'path';
import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerRunStagedReviewCommand } from '../../commands/runStagedReviewCommand';
import * as workspaceRootUtils from '../../utils/workspaceRoot';
import * as multiRootCoordinator from '../../core/multiRootCoordinator';

const createContentHash = (content: string): string =>
    createHash('sha1').update(content, 'utf8').digest('hex');

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
        (vscode as any).workspace = {
            workspaceFolders: [{ uri: { fsPath: 'd:/ws' } }],
            textDocuments: [],
            openTextDocument: vi.fn(),
        };
        const reviewEngine = {
            reviewStagedFilesWithContext: vi.fn(async () => ({ result, stagedFiles: ['a.ts'] })),
        };
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
        expect(reviewEngine.reviewStagedFilesWithContext).toHaveBeenCalledTimes(1);
        expect(reviewPanel.showReviewResult).toHaveBeenCalledWith(result, 'completed', '', '没有staged文件需要审查');
        expect(statusBar.updateWithResult).toHaveBeenCalledWith(result);
    });

    it('异常路径应设置错误状态并提示', async () => {
        const reviewEngine = { reviewStagedFilesWithContext: vi.fn(async () => { throw new Error('boom'); }) };
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

    it('2.2 runStaged 成功应用结果后会更新 lastReviewedContentHash', async () => {
        const result = { passed: true, errors: [], warnings: [], info: [] };
        const content = 'const staged = 1;';
        const expectedHash = createContentHash(content);
        const persist = vi.fn();
        const doc = {
            uri: { scheme: 'file' as const, fsPath: path.normalize('d:/ws/staged-file.ts') },
            getText: () => content,
        };
        const workspace = {
            textDocuments: [doc],
            openTextDocument: vi.fn(async () => doc),
        };
        (vscode as any).workspace = workspace;

        const reviewEngine = {
            reviewStagedFilesWithContext: vi.fn(async () => ({ result, stagedFiles: ['d:/ws/staged-file.ts'] })),
        };
        const reviewPanel = { setStatus: vi.fn(), reveal: vi.fn(), showReviewResult: vi.fn() };
        const statusBar = { updateStatus: vi.fn(), updateWithResult: vi.fn() };
        const logger = { info: vi.fn(), error: vi.fn() };

        registerRunStagedReviewCommand({
            reviewEngine,
            configManager: undefined,
            reviewPanel,
            statusBar,
            logger,
            getGitRoot: () => null,
            persistLastReviewedHash: persist,
        } as any);

        const handler = handlers.get('agentreview.runStaged');
        await handler!();

        expect(persist).toHaveBeenCalledWith('d:/ws/staged-file.ts', expectedHash);
    });

    it('2.3 runStaged 结果未应用（异常）时不更新 lastReviewedContentHash', async () => {
        const persist = vi.fn();
        const reviewEngine = { reviewStagedFilesWithContext: vi.fn(async () => { throw new Error('boom'); }) };
        registerRunStagedReviewCommand({
            reviewEngine,
            configManager: undefined,
            reviewPanel: { setStatus: vi.fn(), reveal: vi.fn(), showReviewResult: vi.fn() },
            statusBar: { updateStatus: vi.fn(), updateWithResult: vi.fn() },
            logger: { info: vi.fn(), error: vi.fn() },
            getGitRoot: () => null,
            persistLastReviewedHash: persist,
        } as any);

        const handler = handlers.get('agentreview.runStaged');
        await handler!();

        expect(persist).not.toHaveBeenCalled();
    });

    it('2.3 runStaged 空 stagedFiles 时不更新 lastReviewedContentHash', async () => {
        const persist = vi.fn();
        const result = { passed: true, errors: [], warnings: [], info: [] };
        const reviewEngine = {
            reviewStagedFilesWithContext: vi.fn(async () => ({ result, stagedFiles: [] })),
        };
        registerRunStagedReviewCommand({
            reviewEngine,
            configManager: undefined,
            reviewPanel: { setStatus: vi.fn(), reveal: vi.fn(), showReviewResult: vi.fn() },
            statusBar: { updateStatus: vi.fn(), updateWithResult: vi.fn() },
            logger: { info: vi.fn(), error: vi.fn() },
            getGitRoot: () => null,
            persistLastReviewedHash: persist,
        } as any);

        const handler = handlers.get('agentreview.runStaged');
        await handler!();

        expect(persist).not.toHaveBeenCalled();
    });

    it('3.2 多根模式应走 staged 聚合调度并汇总结果', async () => {
        const result = { passed: false, errors: [{ file: 'd:/ws-a/a.ts', line: 1, column: 1, message: 'e', rule: 'r', severity: 'error' as const }], warnings: [], info: [] };
        const reviewEngine = { reviewStagedFilesWithContext: vi.fn() };
        const reviewPanel = { setStatus: vi.fn(), reveal: vi.fn(), showReviewResult: vi.fn() };
        const statusBar = { updateStatus: vi.fn(), updateWithResult: vi.fn() };
        const logger = { info: vi.fn(), error: vi.fn() };

        vi.spyOn(workspaceRootUtils, 'getWorkspaceFolders').mockReturnValue([
            { uri: { fsPath: 'd:/ws-a' } } as any,
            { uri: { fsPath: 'd:/ws-b' } } as any,
        ]);
        vi.spyOn(workspaceRootUtils, 'getGitWorkspaceFolders').mockReturnValue([
            { uri: { fsPath: 'd:/ws-a' } } as any,
            { uri: { fsPath: 'd:/ws-b' } } as any,
        ]);
        const aggregateSpy = vi.spyOn(multiRootCoordinator, 'runStagedReviewAcrossRoots').mockResolvedValue({
            result,
            stagedFiles: ['d:/ws-a/a.ts', 'd:/ws-b/b.ts'],
        });

        registerRunStagedReviewCommand({
            reviewEngine,
            configManager: { getConfig: () => ({ ai_review: { batch_concurrency: 4 } }) } as any,
            reviewPanel,
            statusBar,
            logger,
            getGitRoot: () => null,
        } as any);

        const handler = handlers.get('agentreview.runStaged');
        await handler!();

        expect(aggregateSpy).toHaveBeenCalledTimes(1);
        expect(aggregateSpy.mock.calls[0][1]).toEqual(['d:/ws-a', 'd:/ws-b']);
        expect(aggregateSpy.mock.calls[0][2]).toBe(4);
        expect(reviewPanel.showReviewResult).toHaveBeenCalledWith(result, 'completed', '', '没有staged文件需要审查');
        expect(statusBar.updateWithResult).toHaveBeenCalledWith(result);
    });
});
