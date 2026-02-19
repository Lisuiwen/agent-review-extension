import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRunReviewCommand } from '../../commands/runReviewCommand';

type ReviewResult = {
    passed: boolean;
    errors: Array<unknown>;
    warnings: Array<unknown>;
    info: Array<unknown>;
};

describe('runReviewCommand', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    const createDeps = (params: {
        reviewResultContext: {
            result: ReviewResult;
            reason: 'no_pending_changes' | 'reviewed';
            pendingFiles: string[];
        };
        currentResult: ReviewResult | null;
    }) => {
        const reviewEngine = {
            reviewPendingChangesWithContext: vi.fn(async () => params.reviewResultContext),
        };
        const reviewPanel = {
            setStatus: vi.fn(),
            reveal: vi.fn(),
            showReviewResult: vi.fn(),
            getCurrentResult: vi.fn(() => params.currentResult),
            setSubStatus: vi.fn(),
        };
        const statusBar = {
            updateStatus: vi.fn(),
            updateWithResult: vi.fn(),
        };
        const logger = {
            info: vi.fn(),
            error: vi.fn(),
        };
        return {
            reviewEngine,
            reviewPanel,
            statusBar,
            logger,
            configManager: undefined,
            gitHookManager: undefined,
            getGitRoot: () => null,
        } as any;
    };

    it('reviewed+empty+有历史问题时应保留历史，不覆盖列表', async () => {
        const currentResult: ReviewResult = {
            passed: false,
            errors: [{ file: 'a.ts' }],
            warnings: [],
            info: [],
        };
        const deps = createDeps({
            reviewResultContext: {
                result: { passed: true, errors: [], warnings: [], info: [] },
                reason: 'reviewed',
                pendingFiles: ['a.ts'],
            },
            currentResult,
        });

        let commandHandler: (() => Promise<void>) | undefined;
        vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((_, cb) => {
            commandHandler = cb as () => Promise<void>;
            return { dispose: () => undefined };
        });
        const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

        registerRunReviewCommand(deps);
        await commandHandler!();

        expect(deps.reviewPanel.showReviewResult).not.toHaveBeenCalled();
        expect(deps.reviewPanel.setSubStatus).toHaveBeenCalledWith('复审未命中，保留历史问题');
        expect(deps.statusBar.updateWithResult).toHaveBeenCalledWith(currentResult, '复审未命中，保留历史问题');
        expect(infoSpy).toHaveBeenCalledWith('复审未命中，已保留历史问题');
    });

    it('no_pending_changes 时应展示“没有待提交变更需要审查”', async () => {
        const emptyResult: ReviewResult = {
            passed: true,
            errors: [],
            warnings: [],
            info: [],
        };
        const deps = createDeps({
            reviewResultContext: {
                result: emptyResult,
                reason: 'no_pending_changes',
                pendingFiles: [],
            },
            currentResult: null,
        });

        let commandHandler: (() => Promise<void>) | undefined;
        vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((_, cb) => {
            commandHandler = cb as () => Promise<void>;
            return { dispose: () => undefined };
        });

        registerRunReviewCommand(deps);
        await commandHandler!();

        expect(deps.reviewPanel.showReviewResult).toHaveBeenCalledWith(
            emptyResult,
            'completed',
            '',
            '没有待提交变更需要审查'
        );
        expect(deps.statusBar.updateWithResult).toHaveBeenCalledWith(emptyResult);
    });

    it('reviewed+non-empty 时应正常覆盖展示', async () => {
        const reviewedResult: ReviewResult = {
            passed: false,
            errors: [{ file: 'a.ts' }],
            warnings: [],
            info: [],
        };
        const deps = createDeps({
            reviewResultContext: {
                result: reviewedResult,
                reason: 'reviewed',
                pendingFiles: ['a.ts'],
            },
            currentResult: null,
        });

        let commandHandler: (() => Promise<void>) | undefined;
        vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((_, cb) => {
            commandHandler = cb as () => Promise<void>;
            return { dispose: () => undefined };
        });

        registerRunReviewCommand(deps);
        await commandHandler!();

        expect(deps.reviewPanel.showReviewResult).toHaveBeenCalledWith(
            reviewedResult,
            'completed',
            '',
            ''
        );
        expect(deps.statusBar.updateWithResult).toHaveBeenCalledWith(reviewedResult);
    });
});
