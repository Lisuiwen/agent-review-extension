/**
 * 运行汇总日志记录器
 *
 * 按天写入运行汇总：每天一个 YYYYMMDD.jsonl，每行一条当次审核的汇总 JSON。
 * 支持 LLM 耗时与 Token 按 runId 聚合、过期日文件清理。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentReviewConfig } from '../types/config';

/** 单次审核的会话标识，由 startRunSession 返回 */
export interface RuntimeTraceSession {
    runId: string;
    trigger: 'manual' | 'staged';
    startedAt: number;
}

/** 写入 YYYYMMDD.jsonl 的一行汇总 payload 结构（与计划中的统计项一致） */
export interface RunSummaryPayload {
    runId: string;
    startedAt: number;
    endedAt: number;
    /** 开始/结束的时分秒，便于直接看出时间段；日期由文件名 YYYYMMDD 体现 */
    startedAtHms?: string;
    endedAtHms?: string;
    durationMs: number;
    /** 运行时长可读串，如 "2.7秒"、"1分2秒"，便于直接看出运行时长 */
    durationDisplay?: string;
    trigger: 'manual' | 'staged';
    projectName?: string;
    userName?: string;
    userEmail?: string;
    passed: boolean;
    errorsCount: number;
    warningsCount: number;
    infoCount: number;
    inputTokensTotal?: number;
    outputTokensTotal?: number;
    llmTotalMs?: number;
    ignoredByFingerprintCount: number;
    allowedByLineCount: number;
    ignoreStoreCount?: number;
    errorFingerprints: string[];
    warningFingerprints?: string[];
    infoFingerprints?: string[];
    status: 'success' | 'failed';
    errorClass?: string;
    /** 放行/忽略事件：按发生顺序，每条带时分秒 HH:mm:ss（日期由文件名 YYYYMMDD.jsonl 体现） */
    ignoreAllowEvents?: Array<{
        type: 'ignored_by_fingerprint' | 'allowed_by_line';
        at: string;
        file: string;
        line: number;
        fingerprint?: string;
    }>;
}

interface RuntimeLogConfig {
    enabled: boolean;
    retentionDays: number;
}

const DEFAULT_RUNTIME_LOG_CONFIG: RuntimeLogConfig = {
    enabled: true,
    retentionDays: 14,
};

interface RunAggregates {
    llmTotalMs: number;
    inputTokens: number;
    outputTokens: number;
}

export class RuntimeTraceLogger {
    private static instance: RuntimeTraceLogger | undefined;
    private initialized = false;
    private runtimeLogDir: string | null = null;
    private config: RuntimeLogConfig = { ...DEFAULT_RUNTIME_LOG_CONFIG };
    private writeQueue: Promise<void> = Promise.resolve();
    private sessions = new Map<string, RuntimeTraceSession>();
    private runAggregates = new Map<string, RunAggregates>();

    static getInstance = (): RuntimeTraceLogger => {
        if (!RuntimeTraceLogger.instance) {
            RuntimeTraceLogger.instance = new RuntimeTraceLogger();
        }
        return RuntimeTraceLogger.instance;
    };

    async initialize(params: {
        baseDir: string;
        config?: AgentReviewConfig['runtime_log'];
    }): Promise<void> {
        this.runtimeLogDir = path.join(params.baseDir, 'runtime-logs');
        this.applyConfig(params.config);
        await fs.promises.mkdir(this.runtimeLogDir, { recursive: true });
        this.initialized = true;
        await this.cleanupExpiredFiles();
    }

    applyConfig = (config?: AgentReviewConfig['runtime_log']): void => {
        this.config = {
            enabled: config?.enabled ?? DEFAULT_RUNTIME_LOG_CONFIG.enabled,
            retentionDays: Math.max(1, config?.retention_days ?? DEFAULT_RUNTIME_LOG_CONFIG.retentionDays),
        };
    };

    isEnabled = (): boolean => {
        return this.initialized && this.config.enabled && !!this.runtimeLogDir;
    };

    shouldOutputInfoToChannel = (): boolean => {
        return !this.isEnabled();
    };

    startRunSession = (trigger: 'manual' | 'staged'): RuntimeTraceSession | null => {
        if (!this.isEnabled() || !this.runtimeLogDir) {
            return null;
        }
        const runId = this.generateRunId();
        const startedAt = Date.now();
        const session: RuntimeTraceSession = { runId, trigger, startedAt };
        this.sessions.set(runId, session);
        this.runAggregates.set(runId, { llmTotalMs: 0, inputTokens: 0, outputTokens: 0 });
        return session;
    };

    endRunSession = (session?: RuntimeTraceSession | null): void => {
        if (!session) return;
        this.sessions.delete(session.runId);
        this.runAggregates.delete(session.runId);
    };

    /** 单次 LLM 调用结束后调用，用于按 run 聚合耗时与 Token，供 writeRunSummary 写入 */
    addLlmCall = (
        runId: string,
        opts: { durationMs?: number; prompt_tokens?: number; completion_tokens?: number }
    ): void => {
        const agg = this.runAggregates.get(runId);
        if (!agg) return;
        if (typeof opts.durationMs === 'number') agg.llmTotalMs += opts.durationMs;
        if (typeof opts.prompt_tokens === 'number') agg.inputTokens += opts.prompt_tokens;
        if (typeof opts.completion_tokens === 'number') agg.outputTokens += opts.completion_tokens;
    };

    /** 供 ReviewEngine 在写汇总前读取本 run 的 LLM 聚合 */
    getRunAggregates = (runId: string): { llmTotalMs: number; inputTokensTotal: number; outputTokensTotal: number } | null => {
        const agg = this.runAggregates.get(runId);
        if (!agg) return null;
        return {
            llmTotalMs: agg.llmTotalMs,
            inputTokensTotal: agg.inputTokens,
            outputTokensTotal: agg.outputTokens,
        };
    };

    /** 将当次 run 的汇总追加到当日 YYYYMMDD.jsonl */
    writeRunSummary = (session: RuntimeTraceSession | null | undefined, payload: RunSummaryPayload): void => {
        if (!this.isEnabled() || !this.runtimeLogDir || !session) return;
        const dateStr = this.getDateStringFromMs(payload.endedAt);
        const filePath = path.join(this.runtimeLogDir, `${dateStr}.jsonl`);
        const line = `${JSON.stringify(payload)}\n`;
        this.enqueueWrite(filePath, line);
    };

    flushAndCloseAll = async (): Promise<void> => {
        await this.writeQueue;
        this.sessions.clear();
        this.runAggregates.clear();
    };

    flush = async (): Promise<void> => {
        await this.writeQueue;
    };

    /** 根据时间戳得到 YYYYMMDD 文件名前缀 */
    getDateStringFromMs = (ms: number): string => {
        const d = new Date(ms);
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    };

    getRuntimeLogDir = (): string | null => this.runtimeLogDir;

    async cleanupExpiredFiles(): Promise<void> {
        if (!this.isEnabled() || !this.runtimeLogDir) return;
        const retentionDays = Math.max(1, this.config.retentionDays);
        const expireBefore = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const entries = await fs.promises.readdir(this.runtimeLogDir, { withFileTypes: true });
        await Promise.all(entries.map(async (entry) => {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return;
            const fullPath = path.join(this.runtimeLogDir!, entry.name);
            try {
                const stat = await fs.promises.stat(fullPath);
                if (stat.mtimeMs < expireBefore) await fs.promises.unlink(fullPath);
            } catch {
                // 清理失败不影响主流程
            }
        }));
    }

    private enqueueWrite = (filePath: string, line: string): void => {
        this.writeQueue = this.writeQueue
            .then(async () => {
                await fs.promises.appendFile(filePath, line, 'utf8');
            })
            .catch(() => {
                // 单条写入失败不影响主流程
            });
    };

    private generateRunId = (): string => {
        const now = new Date();
        const pad = (n: number): string => n.toString().padStart(2, '0');
        const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
        const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const random = Math.random().toString(36).slice(2, 8);
        return `${date}-${time}-${random}`;
    };
}
