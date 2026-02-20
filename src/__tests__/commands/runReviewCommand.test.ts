import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRunReviewCommand } from '../../commands/runReviewCommand';

type ReviewIssue = {
    file: string;
    line: number;
    column: number;
    message: string;
    rule: string;
    severity: 'error' | 'warning' | 'info';
};

type ReviewResult = {
    passed: boolean;
    errors: ReviewIssue[];
    warnings: ReviewIssue[];
    info: ReviewIssue[];
};

type ReviewResultContext = {
    result: ReviewResult;
    reason: 'no_pending_changes' | 'reviewed';
    pendingFiles: string[];
};

describe('runReviewCommand', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        const progress = { report: () => {} };
        const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
        (vscode.window as { withProgress?: typeof vscode.window.withProgress }).withProgress = (async (_options: unknown, task: (p: unknown, t: unknown) => Thenable<unknown>) => {
            return task(progress, token);
        }) as typeof vscode.window.withProgress;
    });

    const createDeps = (params: {
        reviewResultContext: ReviewResultContext;
        currentResult: ReviewResult | null;
        reviewPendingChangesWithContext?: () => Promise<ReviewResultContext>;
    }) => {
        const reviewEngine = {
            reviewPendingChangesWithContext: params.reviewPendingChangesWithContext ?? vi.fn(async () => params.reviewResultContext),
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
            getGitRoot: () => null,
        } as any;
    };

    it('reviewed+empty+有历史问题时应保留历史，不覆盖列表', async () => {
        const currentResult: ReviewResult = {
            passed: false,
            errors: [{ file: 'a.ts', line: 1, column: 1, message: 'x', rule: 'ai_review', severity: 'error' }],
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

    it('no_pending_changes 时应显示“没有待提交变更需要审查”', async () => {
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

    it('reviewed+non-empty 时应正常覆盖显示', async () => {
        const reviewedResult: ReviewResult = {
            passed: false,
            errors: [{ file: 'a.ts', line: 1, column: 1, message: 'x', rule: 'ai_review', severity: 'error' }],
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

    it('reviewed 分支应在展示前对 AI 同行相似问题去重，并保留非 AI 问题', async () => {
        const reviewedResult: ReviewResult = {
            passed: false,
            errors: [
                {
                    file: 'src/demo.ts',
                    line: 10,
                    column: 1,
                    message: 'Unused variable userName in function',
                    rule: 'ai_review',
                    severity: 'warning',
                },
                {
                    file: 'src/demo.ts',
                    line: 10,
                    column: 2,
                    message: 'Unused variable userName in this function body',
                    rule: 'ai_review',
                    severity: 'error',
                },
                {
                    file: 'src/demo.ts',
                    line: 10,
                    column: 1,
                    message: 'TODO comment is not allowed',
                    rule: 'no_todo',
                    severity: 'warning',
                },
            ],
            warnings: [],
            info: [],
        };
        const deps = createDeps({
            reviewResultContext: {
                result: reviewedResult,
                reason: 'reviewed',
                pendingFiles: ['src/demo.ts'],
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

        expect(deps.reviewPanel.showReviewResult).toHaveBeenCalledTimes(1);
        const displayedResult = (deps.reviewPanel.showReviewResult as ReturnType<typeof vi.fn>).mock.calls[0][0] as ReviewResult;
        const displayedIssues = [...displayedResult.errors, ...displayedResult.warnings, ...displayedResult.info];

        expect(displayedIssues).toHaveLength(2);
        expect(displayedIssues.some((issue) => issue.rule === 'no_todo')).toBe(true);
        expect(displayedIssues.some((issue) => issue.rule === 'ai_review' && issue.severity === 'error')).toBe(true);
    });

    it('并发双击刷新时应忽略第二次触发且不重复调用引擎', async () => {
        let resolveReview: ((value: ReviewResultContext) => void) | null = null;
        const pendingReviewPromise = new Promise<ReviewResultContext>((resolve) => {
            resolveReview = resolve;
        });
        const reviewPendingMock = vi.fn(() => pendingReviewPromise);
        const deps = createDeps({
            reviewResultContext: {
                result: { passed: true, errors: [], warnings: [], info: [] },
                reason: 'reviewed',
                pendingFiles: ['src/demo.ts'],
            },
            currentResult: null,
            reviewPendingChangesWithContext: reviewPendingMock,
        });

        let commandHandler: (() => Promise<void>) | undefined;
        vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((_, cb) => {
            commandHandler = cb as () => Promise<void>;
            return { dispose: () => undefined };
        });
        const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

        registerRunReviewCommand(deps);
        const firstRun = commandHandler!();
        const secondRun = commandHandler!();
        await Promise.resolve();

        expect(reviewPendingMock).toHaveBeenCalledTimes(1);

        resolveReview!({
            result: { passed: true, errors: [], warnings: [], info: [] },
            reason: 'reviewed',
            pendingFiles: ['src/demo.ts'],
        });

        await firstRun;
        await secondRun;

        expect(infoSpy).toHaveBeenCalledWith('审查进行中，已忽略重复刷新');
    });
});
