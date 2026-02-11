import * as fs from 'fs';
import * as path from 'path';
import type { AgentReviewConfig } from '../types/config';

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type RuntimeEventName =
    | 'run_start'
    | 'config_snapshot'
    | 'file_filter_summary'
    | 'diff_fetch_summary'
    | 'run_end'
    | 'ast_scope_summary'
    | 'ast_fallback_summary'
    | 'rule_scan_start'
    | 'rule_scan_summary'
    | 'rule_diff_filter_summary'
    | 'ai_plan_summary'
    | 'ai_batch_start'
    | 'ai_batch_done'
    | 'ai_batch_failed'
    | 'llm_call_start'
    | 'llm_call_done'
    | 'llm_call_abort'
    | 'llm_call_failed'
    | 'llm_retry_scheduled'
    | 'batch_split_triggered';

export type RuntimeEventValue = string | number | boolean | null;
export type RuntimeEventData = Record<string, RuntimeEventValue>;

export interface RuntimeEventRecord {
    ts: string;
    level: RuntimeLogLevel;
    runId: string;
    component: string;
    event: RuntimeEventName;
    phase?: string;
    durationMs?: number;
    data?: RuntimeEventData;
}

export interface RuntimeTraceSession {
    runId: string;
    trigger: 'manual' | 'staged';
    startedAt: number;
}

interface RuntimeTraceSessionState extends RuntimeTraceSession {
    filePath: string;
}

interface RuntimeLogConfig {
    enabled: boolean;
    level: RuntimeLogLevel;
    retentionDays: number;
    fileMode: 'per_run';
    format: 'jsonl';
}

const DEFAULT_RUNTIME_LOG_CONFIG: RuntimeLogConfig = {
    enabled: true,
    level: 'info',
    retentionDays: 14,
    fileMode: 'per_run',
    format: 'jsonl',
};

const LOG_LEVEL_PRIORITY: Record<RuntimeLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const FORBIDDEN_RESULT_KEYS = new Set([
    'issuesCount',
    'errorsCount',
    'warningsCount',
    'infoCount',
    'passed',
]);

export class RuntimeTraceLogger {
    private static instance: RuntimeTraceLogger | undefined;
    private initialized = false;
    private runtimeLogDir: string | null = null;
    private config: RuntimeLogConfig = { ...DEFAULT_RUNTIME_LOG_CONFIG };
    private writeQueue: Promise<void> = Promise.resolve();
    private sessions = new Map<string, RuntimeTraceSessionState>();

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
        const level = config?.level;
        const fileMode = config?.file_mode;
        const format = config?.format;
        this.config = {
            enabled: config?.enabled ?? DEFAULT_RUNTIME_LOG_CONFIG.enabled,
            level: level === 'debug' || level === 'info' || level === 'warn' || level === 'error'
                ? level
                : DEFAULT_RUNTIME_LOG_CONFIG.level,
            retentionDays: Math.max(1, config?.retention_days ?? DEFAULT_RUNTIME_LOG_CONFIG.retentionDays),
            fileMode: fileMode === 'per_run' ? fileMode : DEFAULT_RUNTIME_LOG_CONFIG.fileMode,
            format: format === 'jsonl' ? format : DEFAULT_RUNTIME_LOG_CONFIG.format,
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
        const filePath = path.join(this.runtimeLogDir, `${runId}.jsonl`);
        const startedAt = Date.now();
        const state: RuntimeTraceSessionState = {
            runId,
            trigger,
            startedAt,
            filePath,
        };
        this.sessions.set(runId, state);
        return {
            runId,
            trigger,
            startedAt,
        };
    };

    endRunSession = (session?: RuntimeTraceSession | null): void => {
        if (!session) {
            return;
        }
        this.sessions.delete(session.runId);
    };

    logEvent = (params: {
        session?: RuntimeTraceSession | null;
        level?: RuntimeLogLevel;
        component: string;
        event: RuntimeEventName;
        phase?: string;
        durationMs?: number;
        data?: Record<string, unknown>;
    }): void => {
        if (!this.isEnabled() || !params.session) {
            return;
        }

        const state = this.sessions.get(params.session.runId);
        if (!state) {
            return;
        }

        const level = params.level ?? 'info';
        if (!this.shouldWriteLevel(level)) {
            return;
        }

        const record: RuntimeEventRecord = {
            ts: new Date().toISOString(),
            level,
            runId: state.runId,
            component: params.component,
            event: params.event,
            ...(params.phase ? { phase: params.phase } : {}),
            ...(typeof params.durationMs === 'number' ? { durationMs: params.durationMs } : {}),
            ...(params.data ? { data: this.sanitizeData(params.data) } : {}),
        };

        const line = `${JSON.stringify(record)}\n`;
        this.enqueueWrite(state.filePath, line);
    };

    flushAndCloseAll = async (): Promise<void> => {
        await this.writeQueue;
        this.sessions.clear();
    };

    flush = async (): Promise<void> => {
        await this.writeQueue;
    };

    getRunLogFilePath = (session?: RuntimeTraceSession | null): string | null => {
        if (!session) {
            return null;
        }
        const state = this.sessions.get(session.runId);
        return state?.filePath ?? null;
    };

    async cleanupExpiredFiles(): Promise<void> {
        if (!this.isEnabled() || !this.runtimeLogDir) {
            return;
        }

        const retentionDays = Math.max(1, this.config.retentionDays);
        const expireBefore = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const entries = await fs.promises.readdir(this.runtimeLogDir, { withFileTypes: true });
        await Promise.all(entries.map(async entry => {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                return;
            }
            const fullPath = path.join(this.runtimeLogDir!, entry.name);
            try {
                const stat = await fs.promises.stat(fullPath);
                if (stat.mtimeMs < expireBefore) {
                    await fs.promises.unlink(fullPath);
                }
            } catch {
                // 清理失败不影响主流程
            }
        }));
    }

    private shouldWriteLevel = (level: RuntimeLogLevel): boolean => {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.config.level];
    };

    private enqueueWrite = (filePath: string, line: string): void => {
        this.writeQueue = this.writeQueue
            .then(async () => {
                await fs.promises.appendFile(filePath, line, 'utf8');
            })
            .catch(() => {
                // 单条日志写入失败不影响主流程
            });
    };

    private sanitizeData = (data: Record<string, unknown>): RuntimeEventData => {
        const sanitized: RuntimeEventData = {};
        for (const [key, value] of Object.entries(data)) {
            if (value === undefined) {
                continue;
            }
            if (FORBIDDEN_RESULT_KEYS.has(key)) {
                continue;
            }
            sanitized[key] = this.toPrimitive(value);
        }
        return sanitized;
    };

    private toPrimitive = (value: unknown): RuntimeEventValue => {
        if (value === null) {
            return null;
        }
        const valueType = typeof value;
        if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
            return value as RuntimeEventValue;
        }
        if (value instanceof Error) {
            return value.message;
        }
        return JSON.stringify(value);
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
