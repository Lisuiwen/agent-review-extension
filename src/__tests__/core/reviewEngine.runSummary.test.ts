import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
    execAsync: vi.fn(),
    getRunAggregates: vi.fn(),
    getIgnoreStoreCount: vi.fn(),
    formatTimeHms: vi.fn((ms: number) => `t-${ms}`),
    workspaceFolders: undefined as Array<{ name: string }> | undefined,
}));

vi.mock('util', () => ({
    promisify: () => mocked.execAsync,
}));

vi.mock('child_process', () => ({
    exec: vi.fn(),
}));

vi.mock('vscode', () => ({
    workspace: {
        get workspaceFolders() {
            return mocked.workspaceFolders;
        },
    },
}));

vi.mock('../../utils/runtimeTraceLogger', () => ({
    RuntimeTraceLogger: class {
        static getInstance = () => ({
            getRunAggregates: mocked.getRunAggregates,
        });
    },
}));

vi.mock('../../config/ignoreStore', () => ({
    getIgnoreStoreCount: mocked.getIgnoreStoreCount,
}));

vi.mock('../../utils/runtimeLogExplainer', () => ({
    formatTimeHms: mocked.formatTimeHms,
}));

import { buildRunSummaryPayload, getGitUser } from '../../core/reviewEngine.runSummary';

describe('reviewEngine.runSummary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocked.workspaceFolders = undefined;
        mocked.getRunAggregates.mockReturnValue({
            inputTokensTotal: 10,
            outputTokensTotal: 20,
            llmTotalMs: 30,
        });
        mocked.getIgnoreStoreCount.mockResolvedValue(7);
    });

    it('getGitUser: git 命令失败时应返回空字符串', async () => {
        mocked.execAsync.mockRejectedValue(new Error('git failed'));
        const got = await getGitUser('d:/ws');
        expect(got).toEqual({ userName: '', userEmail: '' });
    });

    it('buildRunSummaryPayload: 应聚合 token、去重指纹并兜底 projectName', async () => {
        mocked.execAsync
            .mockResolvedValueOnce({ stdout: 'Alice\n' })
            .mockResolvedValueOnce({ stdout: 'alice@test.com\n' });
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000);

        const session = {
            runId: 'run-1',
            startedAt: 1_000,
            trigger: 'manual',
        } as any;
        const result = {
            passed: false,
            errors: [
                { file: 'a.ts', line: 1, column: 1, message: 'e1', rule: 'r', severity: 'error', fingerprint: 'fp1' },
                { file: 'a.ts', line: 2, column: 1, message: 'e2', rule: 'r', severity: 'error', fingerprint: 'fp1' },
            ],
            warnings: [
                { file: 'a.ts', line: 3, column: 1, message: 'w1', rule: 'r', severity: 'warning', fingerprint: 'fp2' },
                { file: 'a.ts', line: 4, column: 1, message: 'w2', rule: 'r', severity: 'warning', fingerprint: undefined },
            ],
            info: [{ file: 'a.ts', line: 5, column: 1, message: 'i1', rule: 'r', severity: 'info', fingerprint: 'fp3' }],
        } as any;

        const { payload, logDateMs } = await buildRunSummaryPayload(
            session,
            result,
            'success',
            {
                ignoredByFingerprintCount: 2,
                allowedByLineCount: 1,
            },
            'd:/ws/projectA',
            1_500
        );

        expect(logDateMs).toBe(2_000);
        expect(payload.durationMs).toBe(500);
        expect(payload.projectName).toBe('projectA');
        expect(payload.userName).toBe('Alice');
        expect(payload.userEmail).toBe('alice@test.com');
        expect(payload.ignoreStoreCount).toBe(7);
        expect(payload.inputTokensTotal).toBe(10);
        expect(payload.outputTokensTotal).toBe(20);
        expect(payload.llmTotalMs).toBe(30);
        expect(payload.errorFingerprints).toEqual(['fp1']);
        expect(payload.warningFingerprints).toEqual(['fp2']);
        expect(payload.infoFingerprints).toEqual(['fp3']);
        expect(payload.status).toBe('success');
        nowSpy.mockRestore();
    });

    it('buildRunSummaryPayload: workspaceRoot 为空时 projectName/user/ignoreStore 应兜底', async () => {
        mocked.execAsync.mockRejectedValue(new Error('no git'));
        mocked.workspaceFolders = undefined;
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(5_000);

        const { payload } = await buildRunSummaryPayload(
            { runId: 'run-2', startedAt: 4_000, trigger: 'save' } as any,
            { passed: true, errors: [], warnings: [], info: [] } as any,
            'failed',
            { ignoredByFingerprintCount: 0, allowedByLineCount: 0, errorClass: 'X' },
            '',
            4_000
        );

        expect(payload.projectName).toBeUndefined();
        expect(payload.userName).toBeUndefined();
        expect(payload.userEmail).toBeUndefined();
        expect(payload.ignoreStoreCount).toBe(0);
        expect(payload.errorClass).toBe('X');
        expect(payload.status).toBe('failed');
        nowSpy.mockRestore();
    });
});
