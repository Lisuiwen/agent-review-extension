/**
 * ReviewEngine 运行链路日志完整性测试
 *
 * 目标：
 * 1. 验证 staged 审查会落盘关键链路事件（非结果统计）
 * 2. 验证 AST 开启时会输出 AST 汇总事件
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewEngine } from '../../core/reviewEngine';
import { RuntimeTraceLogger } from '../../utils/runtimeTraceLogger';
import { createMockConfigManager } from '../helpers/mockConfigManager';
import type { FileDiff } from '../../utils/diffTypes';

const stagedFilesMock = vi.fn<() => Promise<string[]>>(async () => []);
const stagedDiffMock = vi.fn<() => Promise<Map<string, FileDiff>>>(async () => new Map());
const shouldExcludeMock = vi.fn<(filePath: string) => boolean>(() => false);
const readFileMock = vi.fn<(filePath: string) => Promise<string>>(async () => '');

vi.mock('../../utils/fileScanner', () => ({
    FileScanner: class {
        getStagedFiles = stagedFilesMock;
        getStagedDiff = stagedDiffMock;
        shouldExclude = shouldExcludeMock;
        readFile = readFileMock;
    },
}));

type RuntimeRecord = {
    runId: string;
    event: string;
    data?: Record<string, unknown>;
};

const readRuntimeRecords = async (baseDir: string): Promise<RuntimeRecord[]> => {
    const runtimeDir = path.join(baseDir, 'runtime-logs');
    const files = (await fs.promises.readdir(runtimeDir))
        .filter(name => name.endsWith('.jsonl'))
        .sort();
    expect(files.length).toBe(1);
    const content = await fs.promises.readFile(path.join(runtimeDir, files[0]), 'utf8');
    return content
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line) as RuntimeRecord);
};

describe('ReviewEngine 运行链路日志完整性', () => {
    const runtimeTraceLogger = RuntimeTraceLogger.getInstance();
    const tempDirs: string[] = [];

    beforeEach(async () => {
        stagedFilesMock.mockReset();
        stagedDiffMock.mockReset();
        shouldExcludeMock.mockReset();
        readFileMock.mockReset();
        shouldExcludeMock.mockReturnValue(false);
        await runtimeTraceLogger.flushAndCloseAll();
    });

    afterEach(async () => {
        await runtimeTraceLogger.flushAndCloseAll();
        await Promise.all(tempDirs.splice(0).map(dir =>
            fs.promises.rm(dir, { recursive: true, force: true })
        ));
    });

    it('staged 审查应输出关键链路事件（含 AI/LLM）', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-trace-it-'));
        tempDirs.push(baseDir);
        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, level: 'info', retention_days: 14, file_mode: 'per_run', format: 'jsonl' },
        });

        const stagedPath = path.normalize('src/app.ts');
        const fileDiff: FileDiff = {
            path: stagedPath,
            hunks: [
                {
                    newStart: 1,
                    newCount: 2,
                    lines: ['const a = 1;', 'const b = 2;'],
                },
            ],
        };
        stagedFilesMock.mockResolvedValue([stagedPath]);
        stagedDiffMock.mockResolvedValue(new Map([[stagedPath, fileDiff]]));
        readFileMock.mockResolvedValue('const a = 1;\nconst b = 2;\n');

        const configManager = createMockConfigManager({
            rules: {
                enabled: true,
                strict_mode: false,
                builtin_rules_enabled: true,
                diff_only: true,
                naming_convention: {
                    enabled: false,
                    action: 'warning',
                    no_space_in_filename: false,
                },
                code_quality: {
                    enabled: true,
                    action: 'warning',
                    no_todo: true,
                },
            },
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-key',
                model: 'test-model',
                timeout: 1000,
                retry_count: 0,
                action: 'warning',
                diff_only: true,
            },
            ast: {
                enabled: false,
            },
            runtime_log: {
                enabled: true,
                level: 'info',
                retention_days: 14,
                file_mode: 'per_run',
                format: 'jsonl',
            },
        });

        const reviewEngine = new ReviewEngine(configManager);
        await reviewEngine.initialize();

        const postMock = vi.fn().mockResolvedValue({
            data: {
                choices: [{ message: { content: '{"issues":[]}' } }],
            },
        });
        ((reviewEngine as unknown as { aiReviewer: { axiosInstance: { post: typeof postMock } } }).aiReviewer).axiosInstance.post = postMock;

        await reviewEngine.reviewStagedFiles();
        await runtimeTraceLogger.flushAndCloseAll();

        const records = await readRuntimeRecords(baseDir);
        expect(records.length).toBeGreaterThan(0);

        const runIds = new Set(records.map(record => record.runId));
        expect(runIds.size).toBe(1);

        const events = records.map(record => record.event);
        const requiredEvents = [
            'diff_fetch_summary',
            'run_start',
            'config_snapshot',
            'file_filter_summary',
            'rule_scan_start',
            'rule_scan_summary',
            'rule_diff_filter_summary',
            'ai_plan_summary',
            'ai_batch_start',
            'llm_call_start',
            'llm_call_done',
            'ai_batch_done',
            'run_end',
        ];
        for (const eventName of requiredEvents) {
            expect(events.includes(eventName)).toBe(true);
        }

        for (const record of records) {
            if (!record.data) continue;
            expect(record.data.issuesCount).toBeUndefined();
            expect(record.data.errorsCount).toBeUndefined();
            expect(record.data.warningsCount).toBeUndefined();
            expect(record.data.passed).toBeUndefined();
        }
    });

    it('开启 AST 后应输出 AST 汇总事件', async () => {
        const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-trace-it-'));
        tempDirs.push(baseDir);
        await runtimeTraceLogger.initialize({
            baseDir,
            config: { enabled: true, level: 'info' },
        });

        const stagedPath = path.normalize('src/feature.ts');
        const fileDiff: FileDiff = {
            path: stagedPath,
            hunks: [
                {
                    newStart: 2,
                    newCount: 1,
                    lines: ['const changed = value + 1;'],
                },
            ],
        };
        stagedFilesMock.mockResolvedValue([stagedPath]);
        stagedDiffMock.mockResolvedValue(new Map([[stagedPath, fileDiff]]));
        readFileMock.mockResolvedValue(
            [
                'const value = 1;',
                'function update() {',
                '  const changed = value + 1;',
                '  return changed;',
                '}',
            ].join('\n')
        );

        const configManager = createMockConfigManager({
            rules: {
                enabled: true,
                strict_mode: false,
                builtin_rules_enabled: false,
            },
            ai_review: {
                enabled: true,
                api_format: 'openai',
                api_endpoint: 'https://api.example.com',
                api_key: 'test-key',
                model: 'test-model',
                timeout: 1000,
                retry_count: 0,
                action: 'warning',
                diff_only: true,
            },
            ast: {
                enabled: true,
                max_node_lines: 100,
                max_file_lines: 2000,
            },
            runtime_log: {
                enabled: true,
                level: 'info',
            },
        });

        const reviewEngine = new ReviewEngine(configManager);
        await reviewEngine.initialize();
        const postMock = vi.fn().mockResolvedValue({
            data: {
                choices: [{ message: { content: '{"issues":[]}' } }],
            },
        });
        ((reviewEngine as unknown as { aiReviewer: { axiosInstance: { post: typeof postMock } } }).aiReviewer).axiosInstance.post = postMock;
        await reviewEngine.reviewStagedFiles();
        await runtimeTraceLogger.flushAndCloseAll();

        const records = await readRuntimeRecords(baseDir);
        const events = records.map(record => record.event);
        expect(events.includes('ast_scope_summary')).toBe(true);
        expect(events.includes('ast_fallback_summary')).toBe(true);
        expect(events.includes('run_end')).toBe(true);
    });
});
