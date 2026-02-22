import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewEngine } from '../../core/reviewEngine';
import type { ReviewIssue } from '../../types/review';
import { createMockConfigManager } from '../helpers/mockConfigManager';

const mocked = vi.hoisted(() => ({
    loadIgnoredFingerprints: vi.fn(async (_root: string) => [] as string[]),
}));

vi.mock('../../config/ignoreStore', async () => {
    const actual = await vi.importActual<typeof import('../../config/ignoreStore')>('../../config/ignoreStore');
    return {
        ...actual,
        loadIgnoredFingerprints: mocked.loadIgnoredFingerprints,
    };
});

describe('ReviewEngine ignore filter by workspaceRoot', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('同一 fingerprint 在不同 workspaceRoot 应隔离过滤', async () => {
        const rootA = 'd:/ws-a';
        const rootB = 'd:/ws-b';
        const fp = 'fp-shared';
        mocked.loadIgnoredFingerprints.mockImplementation(async (root: string) => (root === rootA ? [fp] : []));

        const reviewEngine = new ReviewEngine(createMockConfigManager());
        const issues: ReviewIssue[] = [
            {
                file: 'd:/ws-a/src/a.ts',
                line: 1,
                column: 1,
                message: 'm',
                rule: 'r',
                severity: 'warning',
                fingerprint: fp,
                workspaceRoot: rootA,
            },
            {
                file: 'd:/ws-b/src/a.ts',
                line: 1,
                column: 1,
                message: 'm',
                rule: 'r',
                severity: 'warning',
                fingerprint: fp,
                workspaceRoot: rootB,
            },
        ];

        const got = await (reviewEngine as any).filterIgnoredIssues(issues, rootA);

        expect(got.ignoredByFingerprintCount).toBe(1);
        expect(got.issues).toHaveLength(1);
        expect(got.issues[0].workspaceRoot).toBe(rootB);
        expect(mocked.loadIgnoredFingerprints).toHaveBeenCalledWith(rootA);
        expect(mocked.loadIgnoredFingerprints).toHaveBeenCalledWith(rootB);
    });
});
