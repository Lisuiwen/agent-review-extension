import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    filterGitWorkspaceFolders,
    mergeReviewResults,
    runPendingReviewAcrossRoots,
    runStagedReviewAcrossRoots,
    runWithGlobalConcurrency,
} from '../../core/multiRootCoordinator';

describe('multiRootCoordinator', () => {
    it('仅保留可识别 git 仓库的 workspace folders', () => {
        const folders = [
            { uri: { fsPath: 'd:/ws/a' }, name: 'a' },
            { uri: { fsPath: 'd:/ws/b' }, name: 'b' },
            { uri: { fsPath: 'd:/ws/c' }, name: 'c' },
        ] as unknown as vscode.WorkspaceFolder[];

        const existsSync = vi.fn((p: string) => p.includes('b') || p.includes('c'));
        const result = filterGitWorkspaceFolders(folders, existsSync);
        expect(result.map(item => item.name)).toEqual(['b', 'c']);
    });

    it('全局并发池峰值不超过配置上限', async () => {
        const running = { current: 0, peak: 0 };
        const items = ['a', 'b', 'c', 'd', 'e'];

        await runWithGlobalConcurrency(items, 2, async () => {
            running.current += 1;
            running.peak = Math.max(running.peak, running.current);
            await new Promise(resolve => setTimeout(resolve, 15));
            running.current -= 1;
        });

        expect(running.peak).toBeLessThanOrEqual(2);
    });

    it('跨项目 pending 聚合应合并结果与 pendingFiles', async () => {
        const runner = {
            reviewPendingChangesWithContext: vi.fn(async ({ workspaceRoot }: { workspaceRoot?: string } = {}) => ({
                result: {
                    passed: false,
                    errors: workspaceRoot === 'd:/ws-a' ? [{ file: 'd:/ws-a/a.ts', line: 1, column: 1, message: 'e', rule: 'r', severity: 'error' as const }] : [],
                    warnings: workspaceRoot === 'd:/ws-b' ? [{ file: 'd:/ws-b/b.ts', line: 2, column: 1, message: 'w', rule: 'r', severity: 'warning' as const }] : [],
                    info: [],
                },
                pendingFiles: workspaceRoot ? [`${workspaceRoot}/x.ts`] : [],
                reason: 'reviewed' as const,
            })),
        };

        const got = await runPendingReviewAcrossRoots(runner, ['d:/ws-a', 'd:/ws-b'], 2);

        expect(got.reason).toBe('reviewed');
        expect(got.pendingFiles).toEqual(['d:/ws-a/x.ts', 'd:/ws-b/x.ts']);
        expect(got.result.errors).toHaveLength(1);
        expect(got.result.warnings).toHaveLength(1);
        expect(got.result.passed).toBe(false);
    });

    it('跨项目 staged 聚合应合并结果与 stagedFiles', async () => {
        const runner = {
            reviewStagedFilesWithContext: vi.fn(async ({ workspaceRoot }: { workspaceRoot?: string } = {}) => ({
                result: {
                    passed: true,
                    errors: [],
                    warnings: [],
                    info: workspaceRoot ? [{ file: `${workspaceRoot}/a.ts`, line: 1, column: 1, message: 'i', rule: 'r', severity: 'info' as const }] : [],
                },
                stagedFiles: workspaceRoot ? [`${workspaceRoot}/a.ts`] : [],
            })),
        };

        const got = await runStagedReviewAcrossRoots(runner, ['d:/ws-a', 'd:/ws-b'], 2);

        expect(got.stagedFiles).toEqual(['d:/ws-a/a.ts', 'd:/ws-b/a.ts']);
        expect(got.result.info).toHaveLength(2);
    });

    it('mergeReviewResults 应正确合并 passed 与各级别问题', () => {
        const got = mergeReviewResults([
            { passed: true, errors: [], warnings: [{ file: 'a', line: 1, column: 1, message: 'w', rule: 'r', severity: 'warning' }], info: [] },
            { passed: false, errors: [{ file: 'b', line: 2, column: 1, message: 'e', rule: 'r', severity: 'error' }], warnings: [], info: [] },
        ]);
        expect(got.passed).toBe(false);
        expect(got.errors).toHaveLength(1);
        expect(got.warnings).toHaveLength(1);
    });
});
