import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    explainRuntimeRecords,
    findLatestRuntimeJsonlFile,
    generateRuntimeSummaryForFile,
    parseRuntimeJsonl,
} from '../../utils/runtimeLogExplainer';

describe('runtimeLogExplainer', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map(dir =>
            fs.promises.rm(dir, { recursive: true, force: true })
        ));
    });

    it('应解析 JSONL 并统计非法行', () => {
        const content = [
            '{"ts":"2026-02-10T10:00:00.000Z","level":"info","runId":"r1","component":"ReviewEngine","event":"run_start","phase":"review","data":{"inputFiles":2}}',
            'NOT_JSON',
            '{"ts":"2026-02-10T10:00:01.000Z","level":"info","runId":"r1","component":"ReviewEngine","event":"run_end","phase":"review","durationMs":1000,"data":{"status":"success"}}',
        ].join('\n');
        const result = parseRuntimeJsonl(content);
        expect(result.records.length).toBe(2);
        expect(result.parseSkippedLines).toBe(1);
    });

    it('应输出阶段摘要和关键事件', () => {
        const records = [
            { ts: '2026-02-10T10:00:00.000Z', level: 'info', runId: 'r1', component: 'ReviewEngine', event: 'run_start', phase: 'review', data: { trigger: 'staged' } },
            { ts: '2026-02-10T10:00:00.100Z', level: 'info', runId: 'r1', component: 'ReviewEngine', event: 'file_filter_summary', phase: 'review', data: { inputFiles: 10, excludedFiles: 2, remainingFiles: 8 } },
            { ts: '2026-02-10T10:00:01.000Z', level: 'warn', runId: 'r1', component: 'AIReviewer', event: 'llm_retry_scheduled', phase: 'ai', data: { attempt: 2, delayMs: 2000, reason: 'rate_limit' } },
            { ts: '2026-02-10T10:00:02.000Z', level: 'info', runId: 'r1', component: 'ReviewEngine', event: 'run_end', phase: 'review', durationMs: 2000, data: { status: 'success' } },
        ] as any;
        const text = explainRuntimeRecords(records, { granularity: 'summary_with_key_events' });
        expect(text).toContain('运行日志摘要');
        expect(text).toContain('File Filter');
        expect(text).toContain('关键事件');
        expect(text).toContain('LLM重试');
        expect(text).toContain('瓶颈提示');
    });

    it('应生成 summary 文件', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-explainer-'));
        tempDirs.push(tempDir);
        const jsonlPath = path.join(tempDir, 'r1.jsonl');
        const content = [
            '{"ts":"2026-02-10T10:00:00.000Z","level":"info","runId":"r1","component":"ReviewEngine","event":"run_start","phase":"review","data":{"trigger":"manual"}}',
            '{"ts":"2026-02-10T10:00:01.000Z","level":"info","runId":"r1","component":"ReviewEngine","event":"run_end","phase":"review","durationMs":1000,"data":{"status":"success"}}',
        ].join('\n');
        await fs.promises.writeFile(jsonlPath, content, 'utf8');

        const result = await generateRuntimeSummaryForFile(jsonlPath);
        expect(result.summaryPath.endsWith('.summary.log')).toBe(true);
        expect(await fs.promises.stat(result.summaryPath)).toBeDefined();
    });

    it('应找到最新 jsonl 文件', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-explainer-'));
        tempDirs.push(tempDir);
        const oldFile = path.join(tempDir, 'old.jsonl');
        const newFile = path.join(tempDir, 'new.jsonl');
        await fs.promises.writeFile(oldFile, '{}\n', 'utf8');
        await fs.promises.writeFile(newFile, '{}\n', 'utf8');
        const oldTime = new Date(Date.now() - 3600000);
        await fs.promises.utimes(oldFile, oldTime, oldTime);

        const latest = await findLatestRuntimeJsonlFile(tempDir);
        expect(latest).toBe(newFile);
    });
});

