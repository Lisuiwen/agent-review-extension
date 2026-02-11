import * as fs from 'fs';
import * as path from 'path';
import type { RuntimeEventRecord } from './runtimeTraceLogger';

export type HumanReadableGranularity = 'stage_summary' | 'events' | 'summary_with_key_events';

const KEY_EVENTS = new Set([
    'llm_retry_scheduled',
    'llm_call_failed',
    'llm_call_abort',
    'batch_split_triggered',
    'ai_batch_failed',
]);

export interface RuntimeLogParseResult {
    records: RuntimeEventRecord[];
    parseSkippedLines: number;
}

export const parseRuntimeJsonl = (content: string): RuntimeLogParseResult => {
    const records: RuntimeEventRecord[] = [];
    let parseSkippedLines = 0;
    for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        try {
            records.push(JSON.parse(line) as RuntimeEventRecord);
        } catch {
            parseSkippedLines++;
        }
    }
    records.sort((a, b) => a.ts.localeCompare(b.ts));
    return { records, parseSkippedLines };
};

const formatTime = (ts?: string): string => {
    if (!ts) {
        return 'N/A';
    }
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) {
        return ts;
    }
    return d.toLocaleString('zh-CN', { hour12: false });
};

const formatHmsMs = (ts?: string): string => {
    if (!ts) {
        return 'N/A';
    }
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) {
        return ts;
    }
    const ms = d.getMilliseconds().toString().padStart(3, '0');
    return `${d.toTimeString().slice(0, 8)}.${ms}`;
};

const pickByEvent = (records: RuntimeEventRecord[], event: string): RuntimeEventRecord | undefined =>
    records.find(r => r.event === event);

const safeNum = (v: unknown): string => (typeof v === 'number' ? `${v}` : 'N/A');
const safeVal = (v: unknown): string =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? `${v}` : 'N/A';

const eventLine = (r: RuntimeEventRecord): string => {
    const data = r.data ?? {};
    switch (r.event) {
        case 'llm_retry_scheduled':
            return `[${formatHmsMs(r.ts)}] LLM重试 attempt=${safeVal(data.attempt)} delayMs=${safeVal(data.delayMs)} reason=${safeVal(data.reason)} status=${safeVal(data.statusCode)}`;
        case 'llm_call_failed':
            return `[${formatHmsMs(r.ts)}] LLM调用失败 attempts=${safeVal(data.attempts)} errorClass=${safeVal(data.errorClass)}`;
        case 'llm_call_abort':
            return `[${formatHmsMs(r.ts)}] LLM调用中止 attempts=${safeVal(data.attempts)} errorClass=${safeVal(data.errorClass)}`;
        case 'batch_split_triggered':
            return `[${formatHmsMs(r.ts)}] 批次降载 reason=${safeVal(data.reason)} leftUnits=${safeVal(data.leftUnits)} rightUnits=${safeVal(data.rightUnits)}`;
        case 'ai_batch_failed':
            return `[${formatHmsMs(r.ts)}] AI批次失败 batch=${safeVal(data.batchIndex)}/${safeVal(data.totalBatches)} errorClass=${safeVal(data.errorClass)}`;
        case 'run_end':
            if (data.status === 'failed') {
                return `[${formatHmsMs(r.ts)}] 运行失败 errorClass=${safeVal(data.errorClass)}`;
            }
            return `[${formatHmsMs(r.ts)}] 运行结束 status=${safeVal(data.status)}`;
        default:
            return `[${formatHmsMs(r.ts)}] ${r.component}.${r.event}`;
    }
};

export const explainRuntimeRecords = (
    records: RuntimeEventRecord[],
    options?: { granularity?: HumanReadableGranularity; parseSkippedLines?: number }
): string => {
    if (records.length === 0) {
        return '运行日志摘要\n\n无可用事件记录。';
    }
    const granularity = options?.granularity ?? 'summary_with_key_events';
    const parseSkippedLines = options?.parseSkippedLines ?? 0;
    const runId = records[0].runId;
    const startedAt = records[0].ts;
    const endedAt = records[records.length - 1].ts;
    const runStart = pickByEvent(records, 'run_start');
    const runEnd = [...records].reverse().find(r => r.event === 'run_end');

    const fileFilter = pickByEvent(records, 'file_filter_summary');
    const astSummary = pickByEvent(records, 'ast_scope_summary');
    const ruleSummary = pickByEvent(records, 'rule_scan_summary');
    const aiPlan = pickByEvent(records, 'ai_plan_summary');

    const llmStarts = records.filter(r => r.event === 'llm_call_start').length;
    const llmDones = records.filter(r => r.event === 'llm_call_done');
    const llmRetries = records.filter(r => r.event === 'llm_retry_scheduled');
    const batchSplits = records.filter(r => r.event === 'batch_split_triggered').length;
    const avgLlmCost = llmDones.length === 0
        ? 'N/A'
        : `${Math.round(llmDones.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) / llmDones.length)}`;

    const phaseCost = new Map<string, number>();
    for (const r of records) {
        if (!r.phase || typeof r.durationMs !== 'number') {
            continue;
        }
        phaseCost.set(r.phase, (phaseCost.get(r.phase) ?? 0) + r.durationMs);
    }
    const topPhases = [...phaseCost.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2);

    const lines: string[] = [];
    lines.push('运行日志摘要');
    lines.push(`RunId: ${runId}`);
    lines.push(`开始: ${formatTime(startedAt)}`);
    lines.push(`结束: ${formatTime(endedAt)}`);
    lines.push(`触发方式: ${safeVal(runStart?.data?.trigger)}`);
    lines.push(`总耗时(ms): ${safeNum(runEnd?.durationMs)}`);
    lines.push(`状态: ${safeVal(runEnd?.data?.status)}`);
    lines.push(`解析跳过行: ${parseSkippedLines}`);
    lines.push('');

    if (granularity !== 'events') {
        lines.push('阶段摘要');
        lines.push(`- File Filter: input=${safeVal(fileFilter?.data?.inputFiles)} excluded=${safeVal(fileFilter?.data?.excludedFiles)} remaining=${safeVal(fileFilter?.data?.remainingFiles)}`);
        lines.push(`- AST: attempted=${safeVal(astSummary?.data?.attemptedFiles)} success=${safeVal(astSummary?.data?.successFiles)} fallback=${safeVal(astSummary?.data?.fallbackFiles)} snippets=${safeVal(astSummary?.data?.totalSnippets)} durationMs=${safeNum(astSummary?.durationMs)}`);
        lines.push(`- Rule Scan: files=${safeVal(ruleSummary?.data?.filesScanned)} bytesRead=${safeVal(ruleSummary?.data?.bytesRead)} skippedMissing=${safeVal(ruleSummary?.data?.skippedMissing)} skippedLarge=${safeVal(ruleSummary?.data?.skippedLarge)} skippedBinary=${safeVal(ruleSummary?.data?.skippedBinary)} durationMs=${safeNum(ruleSummary?.durationMs)}`);
        lines.push(`- AI Plan: units=${safeVal(aiPlan?.data?.units)} batches=${safeVal(aiPlan?.data?.batches)} concurrency=${safeVal(aiPlan?.data?.concurrency)} budget=${safeVal(aiPlan?.data?.budget)}`);
        lines.push(`- LLM: calls=${llmStarts} done=${llmDones.length} avgDurationMs=${avgLlmCost} retries=${llmRetries.length} split=${batchSplits}`);
        lines.push('');
    }

    if (granularity === 'events') {
        lines.push('事件明细');
        for (const r of records) {
            lines.push(eventLine(r));
        }
    } else {
        lines.push('关键事件');
        const keyEvents = records.filter(r =>
            KEY_EVENTS.has(r.event) || (r.event === 'run_end' && r.data?.status === 'failed')
        );
        if (keyEvents.length === 0) {
            lines.push('- 无');
        } else {
            for (const r of keyEvents) {
                lines.push(`- ${eventLine(r)}`);
            }
        }
        lines.push('');
        lines.push('瓶颈提示');
        if (topPhases.length === 0) {
            lines.push('- 无可用耗时数据');
        } else {
            for (const [phase, ms] of topPhases) {
                const hint = phase === 'ai'
                    ? '可尝试降低单批体积、提高并发上限或检查模型端耗时。'
                    : phase === 'rules'
                        ? '可检查规则扫描范围与大文件过滤策略。'
                        : phase === 'ast'
                            ? '可检查 AST 切片预算与解析回退比例。'
                            : '可关注该阶段慢事件。';
                lines.push(`- ${phase}: ${ms}ms。${hint}`);
            }
        }
    }

    return lines.join('\n');
};

export const generateRuntimeSummaryForFile = async (
    jsonlPath: string,
    options?: { granularity?: HumanReadableGranularity }
): Promise<{ summaryPath: string; content: string; parseSkippedLines: number }> => {
    const content = await fs.promises.readFile(jsonlPath, 'utf8');
    const parseResult = parseRuntimeJsonl(content);
    const explained = explainRuntimeRecords(parseResult.records, {
        granularity: options?.granularity,
        parseSkippedLines: parseResult.parseSkippedLines,
    });
    const summaryPath = jsonlPath.replace(/\.jsonl$/i, '.summary.log');
    await fs.promises.writeFile(summaryPath, explained, 'utf8');
    return {
        summaryPath,
        content: explained,
        parseSkippedLines: parseResult.parseSkippedLines,
    };
};

export const findLatestRuntimeJsonlFile = async (runtimeLogDir: string): Promise<string | null> => {
    try {
        const entries = await fs.promises.readdir(runtimeLogDir, { withFileTypes: true });
        const files = entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
            .map(entry => path.join(runtimeLogDir, entry.name));
        if (files.length === 0) {
            return null;
        }
        const stats = await Promise.all(files.map(async file => ({
            file,
            mtimeMs: (await fs.promises.stat(file)).mtimeMs,
        })));
        stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return stats[0].file;
    } catch {
        return null;
    }
};

