import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    findLatestRuntimeJsonlFile,
    formatRunSummaryPayload,
    generateRuntimeSummaryForFile,
    parseRunSummaryJsonl,
} from '../../utils/runtimeLogExplainer';
import type { RunSummaryPayload } from '../../utils/runtimeTraceLogger';

const samplePayload: RunSummaryPayload = {
    runId: '20260220-120000-abc',
    startedAt: 1708423200000,
    endedAt: 1708423205000,
    durationMs: 5000,
    trigger: 'manual',
    projectName: 'test-project',
    passed: true,
    errorsCount: 0,
    warningsCount: 1,
    infoCount: 0,
    ignoredByFingerprintCount: 0,
    allowedByLineCount: 0,
    errorFingerprints: [],
    status: 'success',
};

describe('runtimeLogExplainer', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map(dir =>
            fs.promises.rm(dir, { recursive: true, force: true })
        ));
    });

    it('应解析运行汇总 JSONL 并统计非法行', () => {
        const content = [
            JSON.stringify(samplePayload),
            'NOT_JSON',
            JSON.stringify({ ...samplePayload, runId: 'r2' }),
        ].join('\n');
        const result = parseRunSummaryJsonl(content);
        expect(result.payloads.length).toBe(2);
        expect(result.parseSkippedLines).toBe(1);
    });

    it('应格式化单条运行汇总为可读文本', () => {
        const text = formatRunSummaryPayload(samplePayload);
        expect(text).toContain('运行汇总');
        expect(text).toContain(samplePayload.runId);
        expect(text).toContain('通过: true');
        expect(text).toContain('error=0 warning=1 info=0');
    });

    it('应生成 summary 文件（取最后一条汇总）', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-explainer-'));
        tempDirs.push(tempDir);
        const jsonlPath = path.join(tempDir, '20260220.jsonl');
        const line1 = JSON.stringify({ ...samplePayload, runId: 'first' });
        const line2 = JSON.stringify({ ...samplePayload, runId: 'last' });
        await fs.promises.writeFile(jsonlPath, `${line1}\n${line2}\n`, 'utf8');

        const result = await generateRuntimeSummaryForFile(jsonlPath);
        expect(result.summaryPath.endsWith('.summary.log')).toBe(true);
        expect(result.content).toContain('last');
        expect(await fs.promises.stat(result.summaryPath)).toBeDefined();
    });

    it('应找到最新 jsonl 文件', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-explainer-'));
        tempDirs.push(tempDir);
        const oldFile = path.join(tempDir, '20260219.jsonl');
        const newFile = path.join(tempDir, '20260220.jsonl');
        await fs.promises.writeFile(oldFile, '{}\n', 'utf8');
        await fs.promises.writeFile(newFile, '{}\n', 'utf8');
        const oldTime = new Date(Date.now() - 3600000);
        await fs.promises.utimes(oldFile, oldTime, oldTime);

        const latest = await findLatestRuntimeJsonlFile(tempDir);
        expect(latest).toBe(newFile);
    });
});
