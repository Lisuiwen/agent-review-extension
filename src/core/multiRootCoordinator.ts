import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { ReviewResult } from '../types/review';
import type { PendingReviewContext, StagedReviewContext } from './reviewEngine.types';

export const filterGitWorkspaceFolders = (
    folders: vscode.WorkspaceFolder[],
    existsSync: (targetPath: string) => boolean = fs.existsSync
): vscode.WorkspaceFolder[] =>
    folders.filter(folder => existsSync(path.join(folder.uri.fsPath, '.git')));

export const runWithGlobalConcurrency = async <T, R>(
    items: T[],
    maxConcurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
    if (items.length === 0) return [];
    const concurrency = Math.max(1, Math.min(maxConcurrency, items.length));
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            if (currentIndex >= items.length) {
                return;
            }
            results[currentIndex] = await worker(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);
    return results;
};

const createEmptyReviewResult = (): ReviewResult => ({
    passed: true,
    errors: [],
    warnings: [],
    info: [],
});

export const mergeReviewResults = (results: ReviewResult[]): ReviewResult => {
    if (results.length === 0) return createEmptyReviewResult();
    return {
        passed: results.every(item => item.passed),
        errors: results.flatMap(item => item.errors),
        warnings: results.flatMap(item => item.warnings),
        info: results.flatMap(item => item.info),
    };
};

type PendingReviewRunner = {
    reviewPendingChangesWithContext: (options?: { workspaceRoot?: string }) => Promise<PendingReviewContext>;
};

type StagedReviewRunner = {
    reviewStagedFilesWithContext: (options?: { workspaceRoot?: string }) => Promise<StagedReviewContext>;
};

export const runPendingReviewAcrossRoots = async (
    reviewRunner: PendingReviewRunner,
    workspaceRoots: string[],
    maxConcurrency: number
): Promise<PendingReviewContext> => {
    if (workspaceRoots.length === 0) {
        return { result: createEmptyReviewResult(), pendingFiles: [], reason: 'no_pending_changes' };
    }

    const contexts = await runWithGlobalConcurrency(workspaceRoots, maxConcurrency, async (workspaceRoot) =>
        reviewRunner.reviewPendingChangesWithContext({ workspaceRoot })
    );

    return {
        result: mergeReviewResults(contexts.map(item => item.result)),
        pendingFiles: contexts.flatMap(item => item.pendingFiles),
        reason: contexts.some(item => item.reason === 'reviewed') ? 'reviewed' : 'no_pending_changes',
    };
};

export const runStagedReviewAcrossRoots = async (
    reviewRunner: StagedReviewRunner,
    workspaceRoots: string[],
    maxConcurrency: number
): Promise<StagedReviewContext> => {
    if (workspaceRoots.length === 0) {
        return { result: createEmptyReviewResult(), stagedFiles: [] };
    }

    const contexts = await runWithGlobalConcurrency(workspaceRoots, maxConcurrency, async (workspaceRoot) =>
        reviewRunner.reviewStagedFilesWithContext({ workspaceRoot })
    );

    return {
        result: mergeReviewResults(contexts.map(item => item.result)),
        stagedFiles: contexts.flatMap(item => item.stagedFiles),
    };
};
