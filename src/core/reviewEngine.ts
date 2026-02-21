/**
 * 审查引擎
 *
 * 流程概要：
 * 1. 根据配置过滤、排除的文件
 * 2. 根据配置过滤排除的文件
 * 3. 调用 AI 审查器进行 AI 代码审查（若启用）
 * 6. 根据配置决定是否阻止提交
 * 7. 返回结构化的审查结果
 *
 * - 如果项目已有自己的规则引擎，建议保持 builtin_rules_enabled: false
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RuleEngine } from './ruleEngine';
import { AIReviewer } from '../ai/aiReviewer';
import { ConfigManager } from '../config/configManager';
import { Logger } from '../utils/logger';
import { FileScanner } from '../utils/fileScanner';
import { IssueDeduplicator } from './issueDeduplicator';
import type { FileDiff } from '../utils/diffTypes';
import type { ReviewIssue, ReviewResult } from '../types/review';
import { getAffectedScopeWithDiagnostics, type AffectedScopeResult, type AstFallbackReason } from '../utils/astScope';
import { RuntimeTraceLogger, type RuntimeTraceSession, type RunSummaryPayload } from '../utils/runtimeTraceLogger';
import { computeIssueFingerprint } from '../utils/issueFingerprint';
import { loadIgnoredFingerprints, getIgnoreStoreCount } from '../config/ignoreStore';
import { formatTimeHms, formatDurationMs } from '../utils/runtimeLogExplainer';

const execAsync = promisify(exec);

export type { ReviewIssue, ReviewResult } from '../types/review';

type ReviewScopeHint = {
    startLine: number;
    endLine: number;
    source: 'ast' | 'line';
};

type ReviewRunOptions = {
    diffByFile?: Map<string, FileDiff>;
    traceSession?: RuntimeTraceSession | null;
    astSnippetsByFileOverride?: Map<string, AffectedScopeResult>;
};

type PendingReviewContext = {
    result: ReviewResult;
    pendingFiles: string[];
    reason: 'no_pending_changes' | 'reviewed';
};

type ReviewedRange = {
    startLine: number;
    endLine: number;
};

type SavedFileReviewContext = {
    result: ReviewResult;
    reviewedRanges: ReviewedRange[];
    mode: 'diff' | 'full';
    reason: 'reviewed' | 'fallback_full' | 'no_target_diff';
};

type ProjectDiagnosticItem = {
    line: number;
    column: number;
    message: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    code?: string;
    range?: { startLine: number; endLine: number };
};

/**
 * 
 * ```typescript
 * const reviewEngine = new ReviewEngine(configManager);
 * const result = await reviewEngine.reviewStagedFiles();
 * if (!result.passed) {
 * }
 * ```
 */
export class ReviewEngine {
    private ruleEngine: RuleEngine;
    private aiReviewer: AIReviewer;
    private configManager: ConfigManager;
    private fileScanner: FileScanner;
    private logger: Logger;
    private runtimeTraceLogger: RuntimeTraceLogger;

    /**
     * 初始化审查引擎及其依赖的组件
     *
     * @param configManager - 配置管理器，用于读取审查规则配置
     */
    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
        this.logger = new Logger('ReviewEngine');
        this.ruleEngine = new RuleEngine(configManager);
        // AI 审查器：用于 AI 代码审查
        this.aiReviewer = new AIReviewer(configManager);
        this.fileScanner = new FileScanner();
        this.runtimeTraceLogger = RuntimeTraceLogger.getInstance();
    }

    /**
     * 若配置启用 AI 审查，则初始化 AI 审查器。
     */
    async initialize(): Promise<void> {
        const config = this.configManager.getConfig();
        if (config.ai_review?.enabled) {
            await this.aiReviewer.initialize();
        }
    }

    /**
     * 应用运行时日志配置并同步 Logger 是否输出到通道。
     */
    private applyRuntimeTraceConfig = (config: ReturnType<ConfigManager['getConfig']>): void => {
        this.runtimeTraceLogger.applyConfig(config.runtime_log);
        Logger.setInfoOutputEnabled(this.runtimeTraceLogger.shouldOutputInfoToChannel());
    };

    /** 获取 git user.name / user.email，供运行汇总使用；失败返回空字符串 */
    private getGitUser = async (workspaceRoot: string): Promise<{ userName: string; userEmail: string }> => {
        let userName = '';
        let userEmail = '';
        if (!workspaceRoot) return { userName, userEmail };
        try {
            const { stdout } = await execAsync('git config user.name', { cwd: workspaceRoot, encoding: 'utf8' });
            userName = (stdout && typeof stdout === 'string' ? stdout : String(stdout || '')).trim();
        } catch {
            // 忽略
        }
        try {
            const { stdout } = await execAsync('git config user.email', { cwd: workspaceRoot, encoding: 'utf8' });
            userEmail = (stdout && typeof stdout === 'string' ? stdout : String(stdout || '')).trim();
        } catch {
            // 忽略
        }
        return { userName, userEmail };
    };

    /** 组装当次 run 的汇总 payload，用于写入 YYYYMMDD.jsonl */
    private buildRunSummaryPayload = async (
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
    ): Promise<RunSummaryPayload> => {
        const endedAt = Date.now();
        const durationMs = endedAt - reviewStartAt;
        const projectName = vscode.workspace.workspaceFolders?.[0]?.name ?? (workspaceRoot ? path.basename(workspaceRoot) : '');
        const { userName, userEmail } = await this.getGitUser(workspaceRoot);
        const ignoreStoreCount = workspaceRoot ? await getIgnoreStoreCount(workspaceRoot) : 0;
        const aggregates = this.runtimeTraceLogger.getRunAggregates(session.runId);
        const collectFingerprints = (issues: ReviewIssue[]): string[] =>
            [...new Set(issues.map(i => i.fingerprint).filter((f): f is string => !!f))];
        return {
            runId: session.runId,
            startedAt: session.startedAt,
            endedAt,
            startedAtHms: formatTimeHms(session.startedAt),
            endedAtHms: formatTimeHms(endedAt),
            durationMs,
            durationDisplay: formatDurationMs(durationMs),
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
    };

    /**
     * 对指定文件执行规则 + AI 审查，支持 diff/ast 等选项。
     * @param files - 要审查的文件路径数组
     * @returns 审查结果对象
     */
    async review(
        files: string[],
        options?: ReviewRunOptions
    ): Promise<ReviewResult> {
        this.logger.show();
        const reviewStartAt = Date.now();
        const result: ReviewResult = {
            passed: true,
            errors: [],
            warnings: [],
            info: [],
        };

        const config = this.configManager.getConfig();
        if (!options?.traceSession) {
            this.applyRuntimeTraceConfig(config);
        }
        const ownTraceSession = !options?.traceSession;
        const traceSession =
            options?.traceSession ?? this.runtimeTraceLogger.startRunSession(options?.diffByFile ? 'staged' : 'manual');

        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            if (files.length === 0) {
                if (traceSession) {
                    const payload = await this.buildRunSummaryPayload(
                        traceSession,
                        result,
                        'success',
                        { ignoredByFingerprintCount: 0, allowedByLineCount: 0 },
                        workspaceRoot,
                        reviewStartAt
                    );
                    this.runtimeTraceLogger.writeRunSummary(traceSession, payload);
                }
                return result;
            }

            const filteredFiles = files.filter(file => {
                if (config.exclusions) {
                    return !this.fileScanner.shouldExclude(file, config.exclusions);
                }
                return true;
            });

            if (filteredFiles.length === 0) {
                if (traceSession) {
                    const payload = await this.buildRunSummaryPayload(
                        traceSession,
                        result,
                        'success',
                        { ignoredByFingerprintCount: 0, allowedByLineCount: 0 },
                        workspaceRoot,
                        reviewStartAt
                    );
                    this.runtimeTraceLogger.writeRunSummary(traceSession, payload);
                }
                return result;
            }

            const ruleActionMap = new Map<string, 'block_commit' | 'warning' | 'log' | undefined>([
                ['ai_review', config.ai_review?.action],
                ['ai_review_error', config.ai_review?.action],
                ['no_space_in_filename', config.rules.naming_convention?.action],
                ['no_todo', config.rules.code_quality?.action],
                ['no_debugger', config.rules.code_quality?.action],
            ]);

            const useRuleDiff = config.rules.diff_only !== false && options?.diffByFile;
            const useAiDiff = config.ai_review?.diff_only !== false && options?.diffByFile;
            const hasAstOverride = !!options?.astSnippetsByFileOverride && options.astSnippetsByFileOverride.size > 0;
            const useAstScope = hasAstOverride || (config.ast?.enabled === true && options?.diffByFile);
            let astSnippetsByFile: Map<string, AffectedScopeResult> | undefined =
                options?.astSnippetsByFileOverride;

            const buildAstSnippetsByFile = async (
                targetFiles: string[]
            ): Promise<Map<string, AffectedScopeResult> | undefined> => {
                if (hasAstOverride) {
                    return options?.astSnippetsByFileOverride;
                }
                if (!useAstScope || !options?.diffByFile) {
                    return undefined;
                }

                const astStartAt = Date.now();
                const snippetsByFile = new Map<string, AffectedScopeResult>();
                let attemptedFiles = 0;
                const fallbackCounts: Record<AstFallbackReason, number> = {
                    unsupportedExt: 0,
                    parseFailed: 0,
                    maxFileLines: 0,
                    maxNodeLines: 0,
                    emptyResult: 0,
                };
                const addFallback = (reason?: AstFallbackReason): void => {
                    const normalizedReason: AstFallbackReason = reason ?? 'emptyResult';
                    fallbackCounts[normalizedReason] += 1;
                };

                for (const filePath of targetFiles) {
                    const normalizedPath = path.normalize(filePath);
                    const fileDiff = options.diffByFile.get(normalizedPath) ?? options.diffByFile.get(filePath);
                    if (!fileDiff?.hunks?.length) {
                        continue;
                    }
                    attemptedFiles++;
                    try {
                        const content = await this.fileScanner.readFile(filePath);
                        const scopeResult = getAffectedScopeWithDiagnostics(filePath, content, fileDiff, {
                            maxFileLines: config.ast?.max_file_lines,
                            maxNodeLines: config.ast?.max_node_lines,
                        });
                        if (scopeResult.result?.snippets?.length) {
                            snippetsByFile.set(filePath, scopeResult.result);
                        } else {
                            addFallback(scopeResult.fallbackReason);
                        }
                    } catch {
                        addFallback('parseFailed');
                    }
                }

                return snippetsByFile.size > 0 ? snippetsByFile : undefined;
            };

            const ensureAstSnippetsByFile = async (
                targetFiles: string[]
            ): Promise<Map<string, AffectedScopeResult> | undefined> => {
                if (!astSnippetsByFile) {
                    astSnippetsByFile = await buildAstSnippetsByFile(targetFiles);
                }
                return astSnippetsByFile;
            };

            const aiErrorIssues: ReviewIssue[] = [];
            const diagnosticsByFile = this.collectDiagnosticsByFile(filteredFiles);
            const ruleSource = this.resolveRuleSource(diagnosticsByFile);
            const aiInputFilterResult = this.filterFilesForAiReview({
                files: filteredFiles,
                diffByFile: options?.diffByFile,
                diagnosticsByFile,
                aiConfig: config.ai_review,
            });
            const aiInputFiles = aiInputFilterResult.files;
            const runAiReview = async (): Promise<ReviewIssue[]> => {
                if (!config.ai_review?.enabled) {
                    return [];
                }
                if (aiInputFiles.length === 0) {
                    this.logger.info('AI 审查已跳过：当前没有满足条件的文件（可能被格式或漏斗过滤掉）');
                    return [];
                }

                try {
                    const astSnippetsByFile = await ensureAstSnippetsByFile(aiInputFiles);
                    const aiRequest = {
                        files: aiInputFiles.map(file => ({ path: file })),
                        diffByFile: useAiDiff ? options!.diffByFile : undefined,
                        astSnippetsByFile,
                        diagnosticsByFile: this.pickDiagnosticsForFiles(diagnosticsByFile, aiInputFiles),
                    };
                    return await this.aiReviewer.review(aiRequest, traceSession);
                } catch (error) {
                    this.logger.error('AI 审查失败', error);
                    const message = error instanceof Error ? error.message : String(error);
                    const severity = this.actionToSeverity(config.ai_review?.action ?? 'warning');
                    const isTimeout = /timeout|超时/i.test(message);
                    aiErrorIssues.push({
                        file: '',
                        line: 1,
                        column: 1,
                        message: isTimeout ? `AI审查超时: ${message}` : `AI审查失败: ${message}`,
                        rule: isTimeout ? 'ai_review_timeout' : 'ai_review_error',
                        severity,
                    });
                    return [];
                }
            };

            let ruleIssues: ReviewIssue[] = [];
            let aiIssues: ReviewIssue[] = [];

            const skipOnBlocking = config.ai_review?.skip_on_blocking_errors !== false;
            const aiEnabled = config.ai_review?.enabled ?? false;

            const runRuleEngine = (): Promise<ReviewIssue[]> =>
                this.ruleEngine.checkFiles(
                    filteredFiles,
                    useRuleDiff ? options?.diffByFile : undefined,
                    traceSession
                );
            const runProjectRuleChecks = (): ReviewIssue[] => this.buildProjectRuleIssues(diagnosticsByFile);
            const runRules = async (): Promise<ReviewIssue[]> => {
                if (!config.rules.enabled) {
                    return [];
                }
                return ruleSource === 'project'
                    ? runProjectRuleChecks()
                    : runRuleEngine();
            };

            // 固定顺序：规则阶段 ->（硬跳过判断）-> AI 阶段
            ruleIssues = await runRules();
            if (aiEnabled) {
                if (skipOnBlocking && this.hasBlockingErrors(ruleIssues, ruleActionMap)) {
                    this.logger.warn('检测到阻断级规则问题，已跳过AI审查');
                } else {
                    aiIssues = await runAiReview();
                }
            }

            const deduplicatedIssues = IssueDeduplicator.mergeAndDeduplicate(ruleIssues, aiIssues, aiErrorIssues);
            if (workspaceRoot) {
                for (const issue of deduplicatedIssues) {
                    if (issue.fingerprint) continue;
                    try {
                        const content = await this.fileScanner.readFile(issue.file);
                        issue.fingerprint = computeIssueFingerprint(issue, content, workspaceRoot);
                    } catch {
                        // 文件读取失败则跳过该条指纹，过滤时不会按指纹去重
                    }
                }
            }
            const { issues: allIssues, ignoredByFingerprintCount, allowedByLineCount, ignoreAllowEvents } = await this.filterIgnoredIssues(deduplicatedIssues, workspaceRoot);
            this.attachAstRanges(allIssues, astSnippetsByFile);
            this.markIncrementalIssues(allIssues, options?.diffByFile);
            for (const issue of allIssues) {
                if (issue.severity === 'error') result.errors.push(issue);
                else if (issue.severity === 'warning') result.warnings.push(issue);
                else result.info.push(issue);
            }

            const hasBlockingErrors = this.hasBlockingErrors(result.errors, ruleActionMap);
            if (config.rules.strict_mode) {
                result.passed = result.errors.length === 0;
            } else {
                result.passed = !hasBlockingErrors;
            }

            this.logger.info('审查流程完成');
            if (traceSession) {
                const payload = await this.buildRunSummaryPayload(
                    traceSession,
                    result,
                    'success',
                    { ignoredByFingerprintCount, allowedByLineCount, ignoreAllowEvents },
                    workspaceRoot,
                    reviewStartAt
                );
                this.runtimeTraceLogger.writeRunSummary(traceSession, payload);
            }
            return result;
        } catch (error) {
            const errorClass = error instanceof Error ? error.name : 'UnknownError';
            if (traceSession) {
                const emptyResult: ReviewResult = { passed: true, errors: [], warnings: [], info: [] };
                const payload = await this.buildRunSummaryPayload(
                    traceSession,
                    emptyResult,
                    'failed',
                    { errorClass, ignoredByFingerprintCount: 0, allowedByLineCount: 0, ignoreAllowEvents: [] },
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
                    reviewStartAt
                );
                this.runtimeTraceLogger.writeRunSummary(traceSession, payload);
            }
            throw error;
        } finally {
            if (ownTraceSession) {
                this.runtimeTraceLogger.endRunSession(traceSession);
            }
        }
    }

    /**
     * 判断问题列表中是否存在按规则需阻断提交的项（project_rule 看 error，其余看 ruleActionMap）。
     * @param issues - 问题列表
     */
    private hasBlockingErrors = (
        issues: ReviewIssue[],
        ruleActionMap: Map<string, 'block_commit' | 'warning' | 'log' | undefined>
    ): boolean => issues.some(issue =>
        issue.rule.startsWith('project_rule/')
            ? issue.severity === 'error'
            : ruleActionMap.get(issue.rule) === 'block_commit'
    );

    private actionToSeverity = (action: 'block_commit' | 'warning' | 'log'): 'error' | 'warning' | 'info' => {
        switch (action) {
            case 'block_commit': return 'error';
            case 'log': return 'info';
            default: return 'warning';
        }
    };

    private resolveRuleSource = (
        diagnosticsByFile: Map<string, ProjectDiagnosticItem[]>
    ): 'project' | 'builtin' => {
        const source = this.configManager.getRuleSource();
        return source === 'project' && diagnosticsByFile.size > 0 ? 'project' : 'builtin';
    };

    private buildProjectRuleIssues = (
        diagnosticsByFile: Map<string, ProjectDiagnosticItem[]>
    ): ReviewIssue[] => {
        const issues: ReviewIssue[] = [];
        for (const [filePath, diagnostics] of diagnosticsByFile.entries()) {
            for (const item of diagnostics) {
                if (item.severity === 'hint') {
                    continue;
                }
                const ruleSuffix = item.code?.trim() || 'diagnostic';
                issues.push({
                    file: filePath,
                    line: item.line,
                    column: item.column,
                    message: item.message,
                    rule: `project_rule/${ruleSuffix}`,
                    severity: item.severity,
                });
            }
        }
        return issues;
    };

    /**
     * 根据 astSnippetsByFile 为问题补充 astRange（取包含问题行号的最小片段）。
     * @param issues - 需要补充范围的问题列表
     */
    private attachAstRanges = (
        issues: ReviewIssue[],
        astSnippetsByFile?: Map<string, AffectedScopeResult>
    ): void => {
        if (!astSnippetsByFile || issues.length === 0) {
            return;
        }
        const stats = {
            totalIssues: issues.length,
            existingAstRange: 0,
            normalizedHit: 0,
            rawHit: 0,
            missingAstResult: 0,
            noCandidateByLine: 0,
            attached: 0,
        };
        for (const issue of issues) {
            if (issue.astRange) {
                stats.existingAstRange++;
                continue;
            }
            const normalizedPath = path.normalize(issue.file);
            const hitByNormalized = astSnippetsByFile.get(normalizedPath);
            const hitByRaw = astSnippetsByFile.get(issue.file);
            if (hitByNormalized) {
                stats.normalizedHit++;
            } else if (hitByRaw) {
                stats.rawHit++;
            }
            const astResult = hitByNormalized ?? hitByRaw;
            if (!astResult?.snippets?.length) {
                stats.missingAstResult++;
                continue;
            }
            const candidates = astResult.snippets.filter(snippet =>
                issue.line >= snippet.startLine && issue.line <= snippet.endLine
            );
            if (candidates.length === 0) {
                stats.noCandidateByLine++;
                continue;
            }
            const bestSnippet = candidates.reduce((best, current) => {
                const bestSpan = best.endLine - best.startLine;
                const currentSpan = current.endLine - current.startLine;
                return currentSpan <= bestSpan ? current : best;
            });
            issue.astRange = {
                startLine: bestSnippet.startLine,
                endLine: bestSnippet.endLine,
            };
            stats.attached++;
        }
    };

    /**
     * 从 VSCode 语言服务收集各文件的诊断信息，并规范化为行号、严重程度等。
     */
    private collectDiagnosticsByFile = (
        files: string[]
    ): Map<string, ProjectDiagnosticItem[]> => {
        const map = new Map<string, ProjectDiagnosticItem[]>();
        try {
            const diagnosticsGetter = (vscode as unknown as {
                languages?: { getDiagnostics?: (uri?: vscode.Uri) => ReadonlyArray<vscode.Diagnostic> };
            }).languages?.getDiagnostics;
            if (!diagnosticsGetter) {
                return map;
            }
            for (const filePath of files) {
                try {
                    const diagnostics = diagnosticsGetter(vscode.Uri.file(filePath));
                    if (!diagnostics || diagnostics.length === 0) {
                        continue;
                    }
                    map.set(
                        path.normalize(filePath),
                        diagnostics.map(item => ({
                            line: item.range.start.line + 1,
                            column: item.range.start.character + 1,
                            message: item.message,
                            severity: this.toDiagnosticSeverity(item.severity),
                            code: typeof item.code === 'string' ? item.code : undefined,
                            range: {
                                startLine: item.range.start.line + 1,
                                endLine: item.range.end.line + 1,
                            },
                        }))
                    );
                } catch {
                }
            }
            return map;
        } catch {
            return map;
        }
    };

    /** 将 VSCode DiagnosticSeverity 转为统一字符串，供 project rule 与漏斗逻辑使用 */
    private toDiagnosticSeverity = (
        severity: vscode.DiagnosticSeverity | undefined
    ): 'error' | 'warning' | 'info' | 'hint' => {
        switch (severity) {
            case vscode.DiagnosticSeverity.Error: return 'error';
            case vscode.DiagnosticSeverity.Warning: return 'warning';
            case vscode.DiagnosticSeverity.Information: return 'info';
            default: return 'hint';
        }
    };

    private pickDiagnosticsForFiles = (
        diagnosticsByFile: Map<string, ProjectDiagnosticItem[]>,
        filePaths: string[]
    ): Map<string, Array<{ line: number; message: string; range?: { startLine: number; endLine: number } }>> => {
        const picked = new Map<string, Array<{ line: number; message: string; range?: { startLine: number; endLine: number } }>>();
        if (diagnosticsByFile.size === 0) {
            return picked;
        }
        for (const filePath of filePaths) {
            const diagnostics =
                diagnosticsByFile.get(path.normalize(filePath))
                ?? diagnosticsByFile.get(filePath);
            if (!diagnostics?.length) {
                continue;
            }
            picked.set(filePath, diagnostics.map(item => ({
                line: item.line,
                message: item.message,
                range: item.range,
            })));
        }
        return picked;
    };

    /**
     * AI 审查前过滤：格式漏斗：diff 模式下跳过仅格式/空白变更文件
     */
    private filterFilesForAiReview = (params: {
        files: string[];
        diffByFile?: Map<string, FileDiff>;
        diagnosticsByFile: Map<string, ProjectDiagnosticItem[]>;
        aiConfig?: ReturnType<ConfigManager['getConfig']>['ai_review'];
    }): { files: string[]; formatOnlySkippedFiles: number; commentOnlySkippedFiles: number } => {
        const {
            files,
            diffByFile,
            diagnosticsByFile,
            aiConfig,
        } = params;
        const enableFunnel = aiConfig?.funnel_lint === true;
        const funnelSeverity = aiConfig?.funnel_lint_severity ?? 'error';
        const ignoreFormatOnlyDiff = aiConfig?.ignore_format_only_diff !== false;
        const ignoreCommentOnlyDiff = aiConfig?.ignore_comment_only_diff !== false;
        const outputFiles: string[] = [];
        let formatOnlySkippedFiles = 0;
        let commentOnlySkippedFiles = 0;

        for (const filePath of files) {
            const normalizedPath = path.normalize(filePath);

            if (enableFunnel) {
                const diagnostics = diagnosticsByFile.get(normalizedPath) ?? [];
                const hasBlockingDiagnostic = diagnostics.some(item => {
                    if (funnelSeverity === 'warning') {
                        return item.severity === 'error' || item.severity === 'warning';
                    }
                    return item.severity === 'error';
                });
                if (hasBlockingDiagnostic) {
                    continue;
                }
            }

            const fileDiff = diffByFile?.get(normalizedPath) ?? diffByFile?.get(filePath);
            if (fileDiff && ignoreFormatOnlyDiff && fileDiff.formatOnly === true) {
                formatOnlySkippedFiles++;
                continue;
            }
            if (fileDiff && ignoreCommentOnlyDiff && fileDiff.commentOnly === true) {
                commentOnlySkippedFiles++;
                continue;
            }

            outputFiles.push(filePath);
        }

        return {
            files: outputFiles,
            formatOnlySkippedFiles,
            commentOnlySkippedFiles,
        };
    };

    /**
     * 识别并过滤已忽略的问题。顺序不可颠倒：
     * 1) 先按项目级忽略指纹过滤；2) 再按 @ai-ignore 行号过滤（标记行及下一非空行）。
     * 返回过滤后的问题列表、数量及放行/忽略事件列表（每条带时分秒），供运行汇总统计用。
     */
    private filterIgnoredIssues = async (
        issues: ReviewIssue[],
        workspaceRoot: string
    ): Promise<{
        issues: ReviewIssue[];
        ignoredByFingerprintCount: number;
        allowedByLineCount: number;
        ignoreAllowEvents: NonNullable<RunSummaryPayload['ignoreAllowEvents']>;
    }> => {
        const empty = {
            issues: [] as ReviewIssue[],
            ignoredByFingerprintCount: 0,
            allowedByLineCount: 0,
            ignoreAllowEvents: [] as NonNullable<RunSummaryPayload['ignoreAllowEvents']>,
        };
        if (issues.length === 0) return empty;

        let afterFingerprint = issues;
        let ignoredByFingerprintCount = 0;
        const ignoreAllowEvents: NonNullable<RunSummaryPayload['ignoreAllowEvents']> = [];

        if (workspaceRoot) {
            const ignoredSet = new Set(await loadIgnoredFingerprints(workspaceRoot));
            const ignoredByFp = issues.filter(i => i.fingerprint && ignoredSet.has(i.fingerprint));
            afterFingerprint = issues.filter(i => !(i.fingerprint && ignoredSet.has(i.fingerprint)));
            ignoredByFingerprintCount = ignoredByFp.length;
            if (ignoredByFingerprintCount > 0) {
                this.logger.info(`已按指纹过滤 ${ignoredByFingerprintCount} 条项目级忽略问题`);
                const at = formatTimeHms(Date.now());
                for (const i of ignoredByFp) {
                    ignoreAllowEvents.push({
                        type: 'ignored_by_fingerprint',
                        at,
                        file: i.file,
                        line: i.line,
                        fingerprint: i.fingerprint,
                    });
                }
            }
        }

        const issueFiles = Array.from(new Set(afterFingerprint.map(item => path.normalize(item.file))));
        const ignoredLinesByFile = new Map<string, Set<number>>();

        await Promise.all(issueFiles.map(async (filePath) => {
            try {
                const content = await this.fileScanner.readFile(filePath);
                const lines = content.split(/\r?\n/);
                const ignoredLines = new Set<number>();
                for (let i = 0; i < lines.length; i++) {
                    if (!/@ai-ignore\b/i.test(lines[i])) {
                        continue;
                    }
                    const currentLine = i + 1;
                    ignoredLines.add(currentLine);

                    let next = i + 1;
                    while (next < lines.length && lines[next].trim().length === 0) {
                        next++;
                    }
                    if (next < lines.length) {
                        ignoredLines.add(next + 1);
                    }
                }
                if (ignoredLines.size > 0) {
                    ignoredLinesByFile.set(filePath, ignoredLines);
                }
            } catch {
                // 文件读取失败时不做过滤，避免误判问题
            }
        }));

        const filtered = afterFingerprint.filter(issue => {
            const ignoredLines = ignoredLinesByFile.get(path.normalize(issue.file));
            return !ignoredLines?.has(issue.line);
        });
        const allowedByLine = afterFingerprint.filter(issue => {
            const ignoredLines = ignoredLinesByFile.get(path.normalize(issue.file));
            return ignoredLines?.has(issue.line);
        });
        const allowedByLineCount = allowedByLine.length;
        if (allowedByLineCount > 0) {
            this.logger.info(`已过滤 ${allowedByLineCount} 条 @ai-ignore 标记的问题`);
            const at = formatTimeHms(Date.now());
            for (const i of allowedByLine) {
                ignoreAllowEvents.push({ type: 'allowed_by_line', at, file: i.file, line: i.line });
            }
        }
        return { issues: filtered, ignoredByFingerprintCount, allowedByLineCount, ignoreAllowEvents };
    };

    /**
     * 根据 diffByFile 标记每个问题是否属于本次变更行（incremental）；无 diff 时全部标为 incremental。
     */
    private markIncrementalIssues = (issues: ReviewIssue[], diffByFile?: Map<string, FileDiff>): void => {
        if (issues.length === 0) {
            return;
        }
        if (!diffByFile || diffByFile.size === 0) {
            issues.forEach(issue => {
                issue.incremental = true;
            });
            return;
        }
        const changedLinesByFile = new Map<string, Set<number>>();
        for (const [filePath, fileDiff] of diffByFile.entries()) {
            const normalizedPath = path.normalize(filePath);
            const lines = changedLinesByFile.get(normalizedPath) ?? new Set<number>();
            for (const hunk of fileDiff.hunks) {
                for (let i = 0; i < hunk.newCount; i++) {
                    lines.add(hunk.newStart + i);
                }
            }
            changedLinesByFile.set(normalizedPath, lines);
        }
        for (const issue of issues) {
            const lines = changedLinesByFile.get(path.normalize(issue.file));
            issue.incremental = !!lines?.has(issue.line);
        }
    };

    private normalizeScopeHints = (scopes: ReviewScopeHint[]): ReviewScopeHint[] => {
        const normalized = scopes
            .map(scope => {
                if (!Number.isFinite(scope.startLine) || !Number.isFinite(scope.endLine)) {
                    return null;
                }
                const startLine = Math.max(1, Math.floor(scope.startLine));
                const endLine = Math.max(1, Math.floor(scope.endLine));
                if (startLine > endLine) {
                    return null;
                }
                const source: ReviewScopeHint['source'] = scope.source === 'ast' ? 'ast' : 'line';
                return { startLine, endLine, source };
            })
            .filter((scope): scope is ReviewScopeHint => scope !== null);

        if (normalized.length === 0) {
            return [];
        }

        const sorted = [...normalized].sort((a, b) =>
            a.startLine === b.startLine
                ? a.endLine - b.endLine
                : a.startLine - b.startLine
        );
        const merged: ReviewScopeHint[] = [];
        for (const scope of sorted) {
            const last = merged[merged.length - 1];
            if (!last || scope.startLine > last.endLine + 1) {
                merged.push({ ...scope });
                continue;
            }
            last.endLine = Math.max(last.endLine, scope.endLine);
            if (scope.source === 'ast') {
                last.source = 'ast';
            }
        }
        return merged;
    };

    private buildReviewArtifactsFromScopeHints = (
        filePath: string,
        content: string,
        scopes: ReviewScopeHint[]
    ): { diffByFile?: Map<string, FileDiff>; astSnippetsByFile?: Map<string, AffectedScopeResult> } => {
        const lines = content.split(/\r?\n/);
        if (lines.length === 0) {
            return {};
        }

        const hunks: FileDiff['hunks'] = [];
        const snippets: AffectedScopeResult['snippets'] = [];
        for (const scope of scopes) {
            const boundedStart = Math.min(Math.max(1, scope.startLine), lines.length);
            const boundedEnd = Math.min(Math.max(boundedStart, scope.endLine), lines.length);
            const snippetLines = lines.slice(boundedStart - 1, boundedEnd);
            if (snippetLines.length === 0) {
                continue;
            }
            hunks.push({
                newStart: boundedStart,
                newCount: snippetLines.length,
                lines: snippetLines,
            });
            snippets.push({
                startLine: boundedStart,
                endLine: boundedEnd,
                source: snippetLines.join('\n'),
            });
        }

        if (hunks.length === 0 || snippets.length === 0) {
            return {};
        }

        return {
            diffByFile: new Map<string, FileDiff>([
                [filePath, { path: filePath, hunks, formatOnly: false, commentOnly: false }],
            ]),
            astSnippetsByFile: new Map<string, AffectedScopeResult>([
                [filePath, { snippets }],
            ]),
        };
    };

    private createEmptyReviewResult = (): ReviewResult => ({
        passed: true,
        errors: [],
        warnings: [],
        info: [],
    });

    private completeEmptyRun = async (
        traceSession: RuntimeTraceSession | null,
        config: ReturnType<ConfigManager['getConfig']>,
        phase: 'manual' | 'staged',
        trigger: 'manual' | 'staged' | 'save'
    ): Promise<ReviewResult> => {
        return this.createEmptyReviewResult();
    };

    private countReviewIssues = (result: ReviewResult): number =>
        result.errors.length + result.warnings.length + result.info.length;

    private normalizeReviewedRanges = (ranges: ReviewedRange[]): ReviewedRange[] => {
        if (ranges.length === 0) {
            return [];
        }
        const normalized = ranges
            .map(range => {
                const startLine = Math.max(1, Math.floor(range.startLine));
                const endLine = Math.max(startLine, Math.floor(range.endLine));
                return { startLine, endLine };
            })
            .sort((a, b) => (
                a.startLine === b.startLine
                    ? a.endLine - b.endLine
                    : a.startLine - b.startLine
            ));
        const merged: ReviewedRange[] = [];
        for (const range of normalized) {
            const last = merged[merged.length - 1];
            if (!last || range.startLine > last.endLine + 1) {
                merged.push({ ...range });
                continue;
            }
            last.endLine = Math.max(last.endLine, range.endLine);
        }
        return merged;
    };

    private extractReviewedRangesFromDiff = (fileDiff: FileDiff): ReviewedRange[] => {
        const ranges = fileDiff.hunks
            .filter(hunk => Number.isFinite(hunk.newCount) && hunk.newCount > 0)
            .map(hunk => ({
                startLine: hunk.newStart,
                endLine: hunk.newStart + hunk.newCount - 1,
            }));
        return this.normalizeReviewedRanges(ranges);
    };

    private fallbackToFullFileReview = async (
        filePath: string,
        traceSession: RuntimeTraceSession | null,
        reason: string
    ): Promise<ReviewResult> => {
        return await this.review([filePath], { traceSession });
    };

    /**
     */
    async reviewSavedFileWithScopeHints(
        filePath: string,
        scopes: Array<{ startLine: number; endLine: number; source: 'ast' | 'line' }>
    ): Promise<ReviewResult> {
        const config = this.configManager.getConfig();
        this.applyRuntimeTraceConfig(config);
        const traceSession = this.runtimeTraceLogger.startRunSession('manual');
        const normalizedFilePath = path.normalize(filePath);
        const normalizedScopes = this.normalizeScopeHints(scopes);

        try {
            if (!normalizedFilePath) {
                return this.createEmptyReviewResult();
            }
            if (normalizedScopes.length === 0) {
                return await this.fallbackToFullFileReview(
                    normalizedFilePath,
                    traceSession,
                    'scope_hint_fallback_empty_or_invalid_scopes'
                );
            }

            try {
                const content = await this.fileScanner.readFile(normalizedFilePath);
                const artifacts = this.buildReviewArtifactsFromScopeHints(
                    normalizedFilePath,
                    content,
                    normalizedScopes
                );
                if (!artifacts.diffByFile || !artifacts.astSnippetsByFile) {
                    return await this.fallbackToFullFileReview(
                        normalizedFilePath,
                        traceSession,
                        'scope_hint_fallback_empty_snippets_after_bounding'
                    );
                }
                const scopeResult = await this.review([normalizedFilePath], {
                    diffByFile: artifacts.diffByFile,
                    astSnippetsByFileOverride: artifacts.astSnippetsByFile,
                    traceSession,
                });
                if (this.countReviewIssues(scopeResult) > 0) {
                    return scopeResult;
                }

                return await this.fallbackToFullFileReview(
                    normalizedFilePath,
                    traceSession,
                    'scope_hint_empty_result_fallback_full_file'
                );
            } catch {
                return await this.fallbackToFullFileReview(
                    normalizedFilePath,
                    traceSession,
                    'scope_hint_fallback_read_file_failed'
                );
            }
        } finally {
            this.runtimeTraceLogger.endRunSession(traceSession);
        }
    }

    /**
     * 审查 Git staged 文件
     *
     * 这是最常用的审查方法，会自动获取所有已暂存（staged）的文件
     * 通常在以下场景调用：
     * - 用户手动触发审查命令
     *
     * @returns 审查结果对象
     */
    async reviewPendingChangesWithContext(): Promise<PendingReviewContext> {
        this.logger.show();
        const config = this.configManager.getConfig();
        this.applyRuntimeTraceConfig(config);
        const traceSession = this.runtimeTraceLogger.startRunSession('manual');

        try {
            const useDiff = config.rules.diff_only !== false || config.ai_review?.diff_only !== false;
            const pendingDiffByFile = await this.fileScanner.getPendingDiff();
            const pendingFiles = Array.from(pendingDiffByFile.keys()).map(filePath => path.normalize(filePath));
            const diffByFile = useDiff ? pendingDiffByFile : undefined;

            if (pendingFiles.length === 0) {
                return {
                    result: await this.completeEmptyRun(traceSession, config, 'manual', 'manual'),
                    pendingFiles: [],
                    reason: 'no_pending_changes',
                };
            }

            return {
                result: await this.review(pendingFiles, { diffByFile, traceSession }),
                pendingFiles,
                reason: 'reviewed',
            };
        } finally {
            this.runtimeTraceLogger.endRunSession(traceSession);
        }
    }

    async reviewPendingChanges(): Promise<ReviewResult> {
        const context = await this.reviewPendingChangesWithContext();
        return context.result;
    }

    async reviewSavedFileWithPendingDiffContext(filePath: string): Promise<SavedFileReviewContext> {
        const config = this.configManager.getConfig();
        this.applyRuntimeTraceConfig(config);
        const traceSession = this.runtimeTraceLogger.startRunSession('manual');
        const normalizedFilePath = path.normalize(filePath);

        try {
            if (!normalizedFilePath) {
                return {
                    result: this.createEmptyReviewResult(),
                    reviewedRanges: [],
                    mode: 'full',
                    reason: 'no_target_diff',
                };
            }

            try {
                const pendingDiffByFile = await this.fileScanner.getPendingDiff([normalizedFilePath]);
                const matchedDiffEntry = Array.from(pendingDiffByFile.entries()).find(
                    ([key]) => path.normalize(key) === normalizedFilePath
                );
                const matchedDiff = matchedDiffEntry?.[1];
                if (!matchedDiff || matchedDiff.hunks.length === 0) {
                    return {
                        result: await this.fallbackToFullFileReview(
                            normalizedFilePath,
                            traceSession,
                            'pending_diff_fallback_empty_or_invalid_diff'
                        ),
                        reviewedRanges: [],
                        mode: 'full',
                        reason: 'no_target_diff',
                    };
                }

                const diffByFile = new Map<string, FileDiff>([
                    [
                        normalizedFilePath,
                        {
                            ...matchedDiff,
                            path: normalizedFilePath,
                        },
                    ],
                ]);

                return {
                    result: await this.review([normalizedFilePath], {
                        diffByFile,
                        traceSession,
                    }),
                    reviewedRanges: this.extractReviewedRangesFromDiff(matchedDiff),
                    mode: 'diff',
                    reason: 'reviewed',
                };
            } catch {
                return {
                    result: await this.fallbackToFullFileReview(
                        normalizedFilePath,
                        traceSession,
                        'pending_diff_fallback_fetch_failed'
                    ),
                    reviewedRanges: [],
                    mode: 'full',
                    reason: 'fallback_full',
                };
            }
        } finally {
            this.runtimeTraceLogger.endRunSession(traceSession);
        }
    }

    async reviewSavedFileWithPendingDiff(filePath: string): Promise<ReviewResult> {
        const context = await this.reviewSavedFileWithPendingDiffContext(filePath);
        return context.result;
    }

    async reviewStagedFiles(): Promise<ReviewResult> {
        this.logger.show();
        const config = this.configManager.getConfig();
        this.applyRuntimeTraceConfig(config);
        const traceSession = this.runtimeTraceLogger.startRunSession('staged');

        try {
            const stagedFiles = await this.fileScanner.getStagedFiles();
            if (stagedFiles.length === 0) {
                return await this.completeEmptyRun(traceSession, config, 'staged', 'staged');
            }

            const useDiff = config.rules.diff_only !== false || config.ai_review?.diff_only !== false;
            let diffByFile: Map<string, FileDiff> | undefined;
            if (useDiff) {
                diffByFile = await this.fileScanner.getStagedDiff(stagedFiles);
            }

            return await this.review(stagedFiles, { diffByFile, traceSession });
        } finally {
            this.runtimeTraceLogger.endRunSession(traceSession);
        }
    }

    /**
     *
     * 主要用于「保存触发审查」：
     * - 文件尚未 staged 时，也可能命中 diff_only / formatOnly 降噪逻辑
     */
    async reviewFilesWithWorkingDiff(files: string[]): Promise<ReviewResult> {
        const config = this.configManager.getConfig();
        this.applyRuntimeTraceConfig(config);
        const traceSession = this.runtimeTraceLogger.startRunSession('manual');
        const normalizedFiles = files.map(file => path.normalize(file));

        try {
            if (normalizedFiles.length === 0) {
                return await this.completeEmptyRun(traceSession, config, 'manual', 'save');
            }

            const useDiff = config.rules.diff_only !== false || config.ai_review?.diff_only !== false;
            let diffByFile: Map<string, FileDiff> | undefined;
            if (useDiff) {
                diffByFile = await this.fileScanner.getWorkingDiff(normalizedFiles);
            }

            return await this.review(normalizedFiles, { diffByFile, traceSession });
        } finally {
            this.runtimeTraceLogger.endRunSession(traceSession);
        }
    }
}
