import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeTraceLogger, type RunSummaryPayload, type RuntimeTraceSession } from '../../utils/runtimeTraceLogger';

const readJsonl = async (filePath: string): Promise<RunSummaryPayload[]> => {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return content
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line) as RunSummaryPayload);
};

describe('RuntimeTraceLogger', () => {
    const runtimeTraceLogger = RuntimeTraceLogger.getInstance();
    const tempDirs: string[] = [];

    beforeEach(async () => {
        await runtimeTraceLogger.flushAndCloseAll();
    });

    afterEach(async () => {
        await runtimeTraceLogger.flushAndCloseAll();
        await Promise.all(tempDirs.splice(0).map(dir =>
            fs.promises.rm(dir, { recursive: true, force: true })
        ));
    });

    it('每次运行写入 writeRunSummary 后，当日 YYYYMMDD.jsonl 存在且每行可解析为 RunSummaryPayload', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-runtime-'));
        tempDirs.push(baseDir);
        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, retention_days: 14 },
        });

        const session = runtimeTraceLogger.startRunSession('manual');
        expect(session).toBeTruthy();
        const payload: RunSummaryPayload = {
            runId: (session as RuntimeTraceSession).runId,
            startedAtHms: '12:00:00',
            endedAtHms: '12:00:01',
            durationMs: 100,
            trigger: 'manual',
            passed: true,
            errorsCount: 0,
            warningsCount: 0,
            infoCount: 0,
            ignoredByFingerprintCount: 0,
            allowedByLineCount: 0,
            errorFingerprints: [],
            status: 'success',
        };
        const logDateMs = Date.now();
        runtimeTraceLogger.writeRunSummary(session, payload, logDateMs);
        runtimeTraceLogger.endRunSession(session);
        await runtimeTraceLogger.flush();

        const runtimeDir = path.join(baseDir, 'runtime-logs');
        const files = await fs.promises.readdir(runtimeDir);
        expect(files.length).toBe(1);
        expect(files[0].match(/^\d{8}\.jsonl$/)).toBeTruthy();
        const records = await readJsonl(path.join(runtimeDir, files[0]));
        expect(records.length).toBe(1);
        expect(records[0].runId).toBe(payload.runId);
        expect(records[0].durationMs).toBe(100);
    });

    it('同一天两次运行应写入同一 YYYYMMDD.jsonl 两行', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-runtime-'));
        tempDirs.push(baseDir);
        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, retention_days: 14 },
        });

        const sessionA = runtimeTraceLogger.startRunSession('staged');
        const now = Date.now();
        runtimeTraceLogger.writeRunSummary(
            sessionA,
            {
                runId: (sessionA as RuntimeTraceSession).runId,
                startedAtHms: '12:00:00',
                endedAtHms: '12:00:01',
                durationMs: 50,
                trigger: 'staged',
                passed: true,
                errorsCount: 0,
                warningsCount: 0,
                infoCount: 0,
                ignoredByFingerprintCount: 0,
                allowedByLineCount: 0,
                errorFingerprints: [],
                status: 'success',
            },
            now
        );
        runtimeTraceLogger.endRunSession(sessionA);

        const sessionB = runtimeTraceLogger.startRunSession('staged');
        const now2 = Date.now();
        runtimeTraceLogger.writeRunSummary(
            sessionB,
            {
                runId: (sessionB as RuntimeTraceSession).runId,
                startedAtHms: '12:00:01',
                endedAtHms: '12:00:02',
                durationMs: 30,
                trigger: 'staged',
                passed: true,
                errorsCount: 0,
                warningsCount: 0,
                infoCount: 0,
                ignoredByFingerprintCount: 0,
                allowedByLineCount: 0,
                errorFingerprints: [],
                status: 'success',
            },
            now2
        );
        runtimeTraceLogger.endRunSession(sessionB);

        await runtimeTraceLogger.flush();

        const runtimeDir = path.join(baseDir, 'runtime-logs');
        const files = (await fs.promises.readdir(runtimeDir)).filter(name => name.endsWith('.jsonl'));
        expect(files.length).toBe(1);
        const records = await readJsonl(path.join(runtimeDir, files[0]));
        expect(records.length).toBe(2);
    });

    it('enabled=false 时 startRunSession 返回 null，不写入文件', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-runtime-'));
        tempDirs.push(baseDir);
        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: false, retention_days: 14 },
        });

        const session = runtimeTraceLogger.startRunSession('manual');
        expect(session).toBeNull();
        const runtimeDir = path.join(baseDir, 'runtime-logs');
        const entries = await fs.promises.readdir(runtimeDir).catch(() => []);
        const jsonlFiles = entries.filter((n: string) => n.endsWith('.jsonl'));
        expect(jsonlFiles.length).toBe(0);
    });

    it('启动时按 retention_days 清理过期 jsonl 文件', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-runtime-'));
        tempDirs.push(baseDir);
        const runtimeDir = path.join(baseDir, 'runtime-logs');
        await fs.promises.mkdir(runtimeDir, { recursive: true });

        const oldFile = path.join(runtimeDir, '20260101.jsonl');
        const keepFile = path.join(runtimeDir, '20260220.jsonl');
        await fs.promises.writeFile(oldFile, '{}\n', 'utf8');
        await fs.promises.writeFile(keepFile, '{}\n', 'utf8');

        const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
        await fs.promises.utimes(oldFile, twentyDaysAgo, twentyDaysAgo);

        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, retention_days: 14 },
        });

        const files = await fs.promises.readdir(runtimeDir);
        expect(files.includes('20260101.jsonl')).toBe(false);
        expect(files.includes('20260220.jsonl')).toBe(true);
    });

    it('addLlmCall 与 getRunAggregates 按 runId 聚合', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-runtime-'));
        tempDirs.push(baseDir);
        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, retention_days: 14 },
        });

        const session = runtimeTraceLogger.startRunSession('manual');
        expect(session).toBeTruthy();
        const runId = (session as RuntimeTraceSession).runId;
        runtimeTraceLogger.addLlmCall(runId, { durationMs: 100, prompt_tokens: 10, completion_tokens: 5 });
        runtimeTraceLogger.addLlmCall(runId, { durationMs: 50, prompt_tokens: 20, completion_tokens: 8 });

        const agg = runtimeTraceLogger.getRunAggregates(runId);
        expect(agg).toBeTruthy();
        expect(agg!.llmTotalMs).toBe(150);
        expect(agg!.inputTokensTotal).toBe(30);
        expect(agg!.outputTokensTotal).toBe(13);

        runtimeTraceLogger.endRunSession(session);
        expect(runtimeTraceLogger.getRunAggregates(runId)).toBeNull();
    });
});
