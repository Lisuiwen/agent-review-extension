import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeTraceLogger } from '../../utils/runtimeTraceLogger';

const readJsonl = async (filePath: string): Promise<Array<Record<string, unknown>>> => {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return content
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line) as Record<string, unknown>);
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

    it('每次运行会在 runtime-logs 下生成 JSONL 文件，且每行可解析', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-runtime-'));
        tempDirs.push(baseDir);
        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, level: 'info', retention_days: 14, file_mode: 'per_run', format: 'jsonl' },
        });

        const session = runtimeTraceLogger.startRunSession('manual');
        expect(session).toBeTruthy();
        runtimeTraceLogger.logEvent({
            session,
            component: 'ReviewEngine',
            event: 'run_start',
            phase: 'review',
            data: { inputFiles: 3 },
        });
        runtimeTraceLogger.logEvent({
            session,
            component: 'ReviewEngine',
            event: 'run_end',
            phase: 'review',
            durationMs: 120,
            data: { status: 'success' },
        });
        runtimeTraceLogger.endRunSession(session);
        await runtimeTraceLogger.flushAndCloseAll();

        const runtimeDir = path.join(baseDir, 'runtime-logs');
        const files = await fs.promises.readdir(runtimeDir);
        expect(files.length).toBe(1);
        expect(files[0].endsWith('.jsonl')).toBe(true);

        const records = await readJsonl(path.join(runtimeDir, files[0]));
        expect(records.length).toBeGreaterThanOrEqual(2);
        for (const record of records) {
            expect(record.runId).toBeTruthy();
            expect(record.event).toBeTruthy();
        }
    });

    it('连续两次运行应生成不同文件，互不覆盖', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-runtime-'));
        tempDirs.push(baseDir);
        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, level: 'info' },
        });

        const sessionA = runtimeTraceLogger.startRunSession('staged');
        runtimeTraceLogger.logEvent({
            session: sessionA,
            component: 'ReviewEngine',
            event: 'run_start',
            phase: 'staged',
        });
        runtimeTraceLogger.endRunSession(sessionA);

        const sessionB = runtimeTraceLogger.startRunSession('staged');
        runtimeTraceLogger.logEvent({
            session: sessionB,
            component: 'ReviewEngine',
            event: 'run_start',
            phase: 'staged',
        });
        runtimeTraceLogger.endRunSession(sessionB);

        await runtimeTraceLogger.flushAndCloseAll();

        const runtimeDir = path.join(baseDir, 'runtime-logs');
        const files = (await fs.promises.readdir(runtimeDir)).filter(name => name.endsWith('.jsonl'));
        expect(files.length).toBe(2);
        expect(new Set(files).size).toBe(2);
    });

    it('level=warn 时不落盘 info 事件', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-runtime-'));
        tempDirs.push(baseDir);
        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, level: 'warn' },
        });

        const session = runtimeTraceLogger.startRunSession('manual');
        runtimeTraceLogger.logEvent({
            session,
            level: 'info',
            component: 'RuleEngine',
            event: 'rule_scan_start',
            phase: 'rules',
        });
        runtimeTraceLogger.logEvent({
            session,
            level: 'warn',
            component: 'RuleEngine',
            event: 'rule_scan_summary',
            phase: 'rules',
        });
        runtimeTraceLogger.endRunSession(session);
        await runtimeTraceLogger.flushAndCloseAll();

        const runtimeDir = path.join(baseDir, 'runtime-logs');
        const files = (await fs.promises.readdir(runtimeDir)).filter(name => name.endsWith('.jsonl'));
        expect(files.length).toBe(1);
        const records = await readJsonl(path.join(runtimeDir, files[0]));
        expect(records.length).toBe(1);
        expect(records[0].level).toBe('warn');
    });

    it('启动时按 retention_days 清理过期文件', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-runtime-'));
        tempDirs.push(baseDir);
        const runtimeDir = path.join(baseDir, 'runtime-logs');
        await fs.promises.mkdir(runtimeDir, { recursive: true });

        const oldFile = path.join(runtimeDir, 'old.jsonl');
        const keepFile = path.join(runtimeDir, 'keep.jsonl');
        const oldSummaryFile = path.join(runtimeDir, 'old.summary.log');
        const keepSummaryFile = path.join(runtimeDir, 'keep.summary.log');
        await fs.promises.writeFile(oldFile, '{}\n', 'utf8');
        await fs.promises.writeFile(keepFile, '{}\n', 'utf8');
        await fs.promises.writeFile(oldSummaryFile, 'old summary\n', 'utf8');
        await fs.promises.writeFile(keepSummaryFile, 'keep summary\n', 'utf8');

        const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
        await fs.promises.utimes(oldFile, twentyDaysAgo, twentyDaysAgo);
        await fs.promises.utimes(oldSummaryFile, twentyDaysAgo, twentyDaysAgo);

        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, level: 'info', retention_days: 14 },
        });

        const files = await fs.promises.readdir(runtimeDir);
        expect(files.includes('old.jsonl')).toBe(false);
        expect(files.includes('old.summary.log')).toBe(false);
        expect(files.includes('keep.jsonl')).toBe(true);
        expect(files.includes('keep.summary.log')).toBe(true);
    });

    it('运行链路日志会剔除结果统计字段', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-runtime-'));
        tempDirs.push(baseDir);
        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, level: 'info' },
        });

        const session = runtimeTraceLogger.startRunSession('manual');
        runtimeTraceLogger.logEvent({
            session,
            component: 'ReviewEngine',
            event: 'run_end',
            phase: 'review',
            data: {
                durationMs: 42,
                status: 'success',
                issuesCount: 99,
                errorsCount: 12,
                warningsCount: 23,
                passed: false,
            },
        });
        runtimeTraceLogger.endRunSession(session);
        await runtimeTraceLogger.flushAndCloseAll();

        const runtimeDir = path.join(baseDir, 'runtime-logs');
        const files = (await fs.promises.readdir(runtimeDir)).filter(name => name.endsWith('.jsonl'));
        const records = await readJsonl(path.join(runtimeDir, files[0]));
        const data = (records[0].data || {}) as Record<string, unknown>;
        expect(data.durationMs).toBe(42);
        expect(data.status).toBe('success');
        expect(data.issuesCount).toBeUndefined();
        expect(data.errorsCount).toBeUndefined();
        expect(data.warningsCount).toBeUndefined();
        expect(data.passed).toBeUndefined();
    });
});
