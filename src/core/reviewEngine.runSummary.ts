/**
 * 审查引擎：运行汇总
 *
 * 获取 git user.name/user.email、组装当次 run 的 RunSummaryPayload 与写日志用日期戳，
 * 用于写入 YYYYMMDD.jsonl。由 ReviewEngine 在每次 review 结束前后调用。
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ReviewIssue, ReviewResult } from '../types/review';
import { RuntimeTraceLogger, type RuntimeTraceSession, type RunSummaryPayload } from '../utils/runtimeTraceLogger';
import { formatTimeHms } from '../utils/runtimeLogExplainer';
import { getIgnoreStoreCount } from '../config/ignoreStore';

const execAsync = promisify(exec);

/** 读取单个 git config 项；失败返回空字符串 */
const getGitConfig = async (workspaceRoot: string, key: string): Promise<string> => {
    if (!workspaceRoot) return '';
    try {
        const { stdout } = await execAsync(`git config ${key}`, { cwd: workspaceRoot, encoding: 'utf8' });
        const s = stdout != null && typeof stdout === 'string' ? stdout : String(stdout ?? '');
        return s.trim();
    } catch {
        return '';
    }
};

/** 获取 git user.name / user.email，供运行汇总使用；失败返回空字符串 */
export const getGitUser = async (workspaceRoot: string): Promise<{ userName: string; userEmail: string }> => ({
    userName: await getGitConfig(workspaceRoot, 'user.name'),
    userEmail: await getGitConfig(workspaceRoot, 'user.email'),
});

/**
 * 组装当次 run 的汇总 payload 与写日志用的日期戳（仅含 hms 与 durationMs，不含时间戳与 durationDisplay）。
 */
export const buildRunSummaryPayload = async (
    session: RuntimeTraceSession,
    result: ReviewResult,
    status: 'success' | 'failed',
    opts: {
        errorClass?: string;
        ignoredByFingerprintCount: number;
        allowedByLineCount: number;
        ignoreAllowEvents?: RunSummaryPayload['ignoreAllowEvents'];
    },
    workspaceRoot: string,
    reviewStartAt: number
): Promise<{ payload: RunSummaryPayload; logDateMs: number }> => {
    const endedAt = Date.now();
    const durationMs = endedAt - reviewStartAt;
    const projectName = vscode.workspace.workspaceFolders?.[0]?.name ?? (workspaceRoot ? path.basename(workspaceRoot) : '');
    const { userName, userEmail } = await getGitUser(workspaceRoot);
    const ignoreStoreCount = workspaceRoot ? await getIgnoreStoreCount(workspaceRoot) : 0;
    const runtimeTraceLogger = RuntimeTraceLogger.getInstance();
    const aggregates = runtimeTraceLogger.getRunAggregates(session.runId);
    const collectFingerprints = (issues: ReviewIssue[]): string[] =>
        [...new Set(issues.map(i => i.fingerprint).filter((f): f is string => !!f))];
    const payload: RunSummaryPayload = {
        runId: session.runId,
        startedAtHms: formatTimeHms(session.startedAt),
        endedAtHms: formatTimeHms(endedAt),
        durationMs,
        trigger: session.trigger,
        projectName: projectName || undefined,
        userName: userName || undefined,
        userEmail: userEmail || undefined,
        passed: result.passed,
        errorsCount: result.errors.length,
        warningsCount: result.warnings.length,
        infoCount: result.info.length,
        inputTokensTotal: aggregates?.inputTokensTotal ?? 0,
        outputTokensTotal: aggregates?.outputTokensTotal ?? 0,
        llmTotalMs: aggregates?.llmTotalMs ?? 0,
        ignoredByFingerprintCount: opts.ignoredByFingerprintCount,
        allowedByLineCount: opts.allowedByLineCount,
        ignoreStoreCount,
        errorFingerprints: collectFingerprints(result.errors),
        warningFingerprints: collectFingerprints(result.warnings),
        infoFingerprints: collectFingerprints(result.info),
        status,
        errorClass: opts.errorClass,
        ignoreAllowEvents: opts.ignoreAllowEvents ?? [],
    };
    return { payload, logDateMs: endedAt };
};
