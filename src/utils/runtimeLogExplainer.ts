/**
 * 运行汇总日志可读化
 *
 * 解析按日存储的 YYYYMMDD.jsonl（每行一条 RunSummaryPayload），
 * 取最新日文件最后一行，格式化为可读摘要供命令展示。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RunSummaryPayload } from './runtimeTraceLogger';

/** 解析 JSONL 内容为运行汇总列表；无效行计入 parseSkippedLines */
export const parseRunSummaryJsonl = (content: string): { payloads: RunSummaryPayload[]; parseSkippedLines: number } => {
    const payloads: RunSummaryPayload[] = [];
    let parseSkippedLines = 0;
    for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            payloads.push(JSON.parse(line) as RunSummaryPayload);
        } catch {
            parseSkippedLines++;
        }
    }
    return { payloads, parseSkippedLines };
};

/** 将时间戳格式化为 HH:mm:ss（日期由日志文件名 YYYYMMDD.jsonl 体现） */
export const formatTimeHms = (ms: number): string => {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return 'N/A';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** 将毫秒数格式化为可读运行时长，如 "2.7秒"、"1分2秒" */
export const formatDurationMs = (ms: number): string => {
    if (typeof ms !== 'number' || ms < 0) return 'N/A';
    if (ms < 1000) return `${ms}毫秒`;
    if (ms < 60 * 1000) return `${(ms / 1000).toFixed(1)}秒`;
    const min = Math.floor(ms / 60000);
    const sec = ((ms % 60000) / 1000).toFixed(1);
    return sec === '0.0' ? `${min}分` : `${min}分${sec}秒`;
};

const safe = (v: unknown): string =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? `${v}` : 'N/A';

/** 将单条运行汇总格式化为可读文本（时间仅用 hms，时长仅用毫秒数）。 */
export const formatRunSummaryPayload = (p: RunSummaryPayload): string => {
    const lines: string[] = [];
    lines.push('运行汇总');
    lines.push(`RunId: ${p.runId}`);
    lines.push(`开始: ${p.startedAtHms ?? 'N/A'}`);
    lines.push(`结束: ${p.endedAtHms ?? 'N/A'}`);
    lines.push(`运行时长: ${p.durationMs}ms`);
    lines.push(`触发: ${p.trigger}`);
    lines.push(`状态: ${p.status}${p.errorClass ? ` (${p.errorClass})` : ''}`);
    lines.push(`通过: ${p.passed}`);
    if (p.projectName) lines.push(`项目: ${p.projectName}`);
    if (p.userName ?? p.userEmail) lines.push(`用户: ${p.userName ?? ''} ${p.userEmail ?? ''}`.trim());
    lines.push(`问题: error=${p.errorsCount} warning=${p.warningsCount} info=${p.infoCount}`);
    if (p.inputTokensTotal != null || p.outputTokensTotal != null) {
        lines.push(`Token: 输入=${safe(p.inputTokensTotal)} 输出=${safe(p.outputTokensTotal)}`);
    }
    if (p.llmTotalMs != null) lines.push(`LLM 总耗时(ms): ${p.llmTotalMs}`);
    lines.push(`忽略: 按指纹=${p.ignoredByFingerprintCount} 按行=${p.allowedByLineCount}`);
    if (p.ignoreStoreCount != null) lines.push(`忽略表条数: ${p.ignoreStoreCount}`);
    if (p.ignoreAllowEvents?.length) {
        lines.push('');
        lines.push('放行/忽略事件');
        for (const e of p.ignoreAllowEvents) {
            if (e.type === 'ignored_by_fingerprint') {
                lines.push(`  [${e.at}] 忽略(指纹) ${e.file}:${e.line}${e.fingerprint ? ` ${e.fingerprint}` : ''}`);
            } else {
                lines.push(`  [${e.at}] 放行(行) ${e.file}:${e.line}`);
            }
        }
    }
    return lines.join('\n');
};

/** 查找目录下按修改时间最新的 .jsonl 文件（即“最新日”文件） */
export const findLatestRuntimeJsonlFile = async (runtimeLogDir: string): Promise<string | null> => {
    try {
        const entries = await fs.promises.readdir(runtimeLogDir, { withFileTypes: true });
        const files = entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
            .map(entry => path.join(runtimeLogDir, entry.name));
        if (files.length === 0) return null;
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

/**
 * 读取指定 JSONL 文件，取最后一条运行汇总，格式化为可读内容并可选写入同名的 .summary.log。
 * 供“解释运行日志”命令使用：展示最新一次审核的汇总。
 */
export const generateRuntimeSummaryForFile = async (
    jsonlPath: string,
    _options?: { granularity?: string }
): Promise<{ summaryPath: string; content: string; parseSkippedLines: number }> => {
    const content = await fs.promises.readFile(jsonlPath, 'utf8');
    const { payloads, parseSkippedLines } = parseRunSummaryJsonl(content);
    const last = payloads.length > 0 ? payloads[payloads.length - 1] : null;
    const explained = last ? formatRunSummaryPayload(last) : '运行汇总\n\n该文件中无有效运行记录。';
    const summaryPath = jsonlPath.replace(/\.jsonl$/i, '.summary.log');
    await fs.promises.writeFile(summaryPath, explained, 'utf8');
    return {
        summaryPath,
        content: explained,
        parseSkippedLines,
    };
};
