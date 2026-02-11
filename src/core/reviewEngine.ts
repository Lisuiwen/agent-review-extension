/**
 * 审查引擎
 * 
 * 这是整个插件的核心组件，负责协调各个子系统完成代码审查
 * 
 * 主要职责：
 * 1. 接收文件列表，执行代码审查
 * 2. 根据配置决定是否调用内置规则引擎检查代码问题
 * 3. 调用AI审查器进行AI代码审查（如果启用）
 * 4. 根据配置决定是否阻止提交
 * 5. 返回结构化的审查结果
 * 
 * 工作流程：
 * 1. 获取需要审查的文件列表（通常是 git staged 文件）
 * 2. 根据配置过滤掉排除的文件
 * 3. 如果启用内置规则引擎（rules.builtin_rules_enabled），调用规则引擎检查每个文件
 * 4. 如果启用AI审查（ai_review.enabled），调用AI审查器
 * 5. 合并规则引擎和AI审查的结果，并去重
 * 6. 将问题按严重程度分类（error/warning/info）
 * 7. 根据配置判断是否通过审查
 * 
 * 注意：
 * - 内置规则引擎默认禁用（builtin_rules_enabled: false），避免与项目自有规则冲突
 * - 如果项目已有自己的规则引擎，建议保持 builtin_rules_enabled: false
 */

import * as path from 'path';
import { RuleEngine } from './ruleEngine';
import { AIReviewer } from '../ai/aiReviewer';
import { ConfigManager } from '../config/configManager';
import { Logger } from '../utils/logger';
import { FileScanner } from '../utils/fileScanner';
import { IssueDeduplicator } from './issueDeduplicator';
import type { FileDiff } from '../utils/diffTypes';
import type { ReviewIssue, ReviewResult } from '../types/review';
import { getAffectedScopeWithDiagnostics, type AffectedScopeResult, type AstFallbackReason } from '../utils/astScope';
import { RuntimeTraceLogger, type RuntimeTraceSession } from '../utils/runtimeTraceLogger';
import { generateRuntimeSummaryForFile } from '../utils/runtimeLogExplainer';

// 为保持向后兼容，从 reviewEngine 继续 export 类型（实际定义在 types/review）
export type { ReviewIssue, ReviewResult } from '../types/review';

/**
 * 审查引擎类
 * 
 * 使用方式：
 * ```typescript
 * const reviewEngine = new ReviewEngine(configManager);
 * const result = await reviewEngine.reviewStagedFiles();
 * if (!result.passed) {
 *     console.log('审查未通过，发现', result.errors.length, '个错误');
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
     * 构造函数
     * 初始化审查引擎及其依赖的组件
     * 
     * @param configManager - 配置管理器，用于读取审查规则配置
     */
    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
        this.logger = new Logger('ReviewEngine');
        // 规则引擎：负责执行具体的规则检查
        this.ruleEngine = new RuleEngine(configManager);
        // AI审查器：用于AI代码审查
        this.aiReviewer = new AIReviewer(configManager);
        // 文件扫描器：用于获取文件列表和读取文件内容
        this.fileScanner = new FileScanner();
        this.runtimeTraceLogger = RuntimeTraceLogger.getInstance();
    }

    /**
     * 初始化审查引擎
     * 初始化AI审查器（如果启用）
     */
    async initialize(): Promise<void> {
        const config = this.configManager.getConfig();
        if (config.ai_review?.enabled) {
            await this.aiReviewer.initialize();
        }
    }

    /**
     * 审查指定的文件列表
     *
     * 当 options.diffByFile 存在且配置启用时，规则引擎仅扫描变更行、AI 仅审查变更片段。
     *
     * @param files - 要审查的文件路径数组
     * @param options - 可选；diffByFile 为 staged 文件的 diff 映射，由 reviewStagedFiles 注入
     * @returns 审查结果对象
     */
    async review(
        files: string[],
        options?: { diffByFile?: Map<string, FileDiff>; traceSession?: RuntimeTraceSession | null }
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
        this.runtimeTraceLogger.applyConfig(config.runtime_log);
        Logger.setInfoOutputEnabled(this.runtimeTraceLogger.shouldOutputInfoToChannel());
        const ownTraceSession = !options?.traceSession;
        const traceSession =
            options?.traceSession ?? this.runtimeTraceLogger.startRunSession(options?.diffByFile ? 'staged' : 'manual');

        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'ReviewEngine',
            event: 'run_start',
            phase: 'review',
            data: {
                inputFiles: files.length,
                trigger: traceSession?.trigger ?? 'manual',
            },
        });
        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'ReviewEngine',
            event: 'config_snapshot',
            phase: 'review',
            data: {
                rulesEnabled: config.rules.enabled,
                ruleDiffOnly: config.rules.diff_only ?? true,
                aiEnabled: config.ai_review?.enabled ?? false,
                aiDiffOnly: config.ai_review?.diff_only ?? true,
                astEnabled: config.ast?.enabled ?? false,
                astMaxNodeLines: config.ast?.max_node_lines ?? 0,
                astMaxFileLines: config.ast?.max_file_lines ?? 0,
                aiBatchingMode: config.ai_review?.batching_mode ?? 'file_count',
                aiBatchConcurrency: config.ai_review?.batch_concurrency ?? 2,
                aiMaxRequestChars: config.ai_review?.max_request_chars ?? 50000,
            },
        });

        try {
            if (files.length === 0) {
                this.runtimeTraceLogger.logEvent({
                    session: traceSession,
                    component: 'ReviewEngine',
                    event: 'run_end',
                    phase: 'review',
                    durationMs: Date.now() - reviewStartAt,
                    data: { status: 'success' },
                });
                await this.generateRuntimeSummaryIfEnabled(traceSession, config);
                return result;
            }

            const filteredFiles = files.filter(file => {
                if (config.exclusions) {
                    return !this.fileScanner.shouldExclude(file, config.exclusions);
                }
                return true;
            });

            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'ReviewEngine',
                event: 'file_filter_summary',
                phase: 'review',
                data: {
                    inputFiles: files.length,
                    excludedFiles: files.length - filteredFiles.length,
                    remainingFiles: filteredFiles.length,
                },
            });

            if (filteredFiles.length === 0) {
                this.runtimeTraceLogger.logEvent({
                    session: traceSession,
                    component: 'ReviewEngine',
                    event: 'run_end',
                    phase: 'review',
                    durationMs: Date.now() - reviewStartAt,
                    data: { status: 'success' },
                });
                await this.generateRuntimeSummaryIfEnabled(traceSession, config);
                return result;
            }

            const ruleActionMap = new Map<string, 'block_commit' | 'warning' | 'log' | undefined>([
                ['ai_review', config.ai_review?.action],
                ['ai_review_error', config.ai_review?.action],
                ['no_space_in_filename', config.rules.naming_convention?.action],
                ['no_todo', config.rules.code_quality?.action],
            ]);

            const useRuleDiff = config.rules.diff_only !== false && options?.diffByFile;
            const useAiDiff = config.ai_review?.diff_only !== false && options?.diffByFile;
            const useAstScope = config.ast?.enabled === true && options?.diffByFile;
            let astSnippetsByFile: Map<string, AffectedScopeResult> | undefined;

            const buildAstSnippetsByFile = async (): Promise<Map<string, AffectedScopeResult> | undefined> => {
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

                for (const filePath of filteredFiles) {
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

                const totalAstSnippets = Array.from(snippetsByFile.values())
                    .reduce((sum, item) => sum + item.snippets.length, 0);
                this.runtimeTraceLogger.logEvent({
                    session: traceSession,
                    component: 'ReviewEngine',
                    event: 'ast_scope_summary',
                    phase: 'ast',
                    durationMs: Date.now() - astStartAt,
                    data: {
                        attemptedFiles,
                        successFiles: snippetsByFile.size,
                        fallbackFiles: attemptedFiles - snippetsByFile.size,
                        totalSnippets: totalAstSnippets,
                    },
                });
                this.runtimeTraceLogger.logEvent({
                    session: traceSession,
                    component: 'ReviewEngine',
                    event: 'ast_fallback_summary',
                    phase: 'ast',
                    data: {
                        unsupportedExt: fallbackCounts.unsupportedExt,
                        parseFailed: fallbackCounts.parseFailed,
                        maxFileLines: fallbackCounts.maxFileLines,
                        maxNodeLines: fallbackCounts.maxNodeLines,
                        emptyResult: fallbackCounts.emptyResult,
                    },
                });

                return snippetsByFile.size > 0 ? snippetsByFile : undefined;
            };

            const ensureAstSnippetsByFile = async (): Promise<Map<string, AffectedScopeResult> | undefined> => {
                if (!astSnippetsByFile) {
                    astSnippetsByFile = await buildAstSnippetsByFile();
                }
                return astSnippetsByFile;
            };

            const aiErrorIssues: ReviewIssue[] = [];
            const runAiReview = async (): Promise<ReviewIssue[]> => {
                if (!config.ai_review?.enabled) {
                    return [];
                }

                try {
                    const astSnippetsByFile = await ensureAstSnippetsByFile();
                    const aiRequest = {
                        files: filteredFiles.map(file => ({ path: file })),
                        diffByFile: useAiDiff ? options!.diffByFile : undefined,
                        astSnippetsByFile,
                    };
                    return await this.aiReviewer.review(aiRequest, traceSession);
                } catch (error) {
                    this.logger.error('AI审查失败', error);
                    const message = error instanceof Error ? error.message : String(error);
                    const action = config.ai_review?.action || 'warning';
                    const severity = action === 'block_commit'
                        ? 'error'
                        : action === 'log'
                            ? 'info'
                            : 'warning';
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

            const builtinRulesEnabled = config.rules.builtin_rules_enabled !== false && config.rules.enabled;
            const skipOnBlocking = config.ai_review?.skip_on_blocking_errors !== false;
            if (config.ai_review?.enabled) {
                if (skipOnBlocking) {
                    if (builtinRulesEnabled) {
                        ruleIssues = await this.ruleEngine.checkFiles(
                            filteredFiles,
                            useRuleDiff ? options?.diffByFile : undefined,
                            traceSession
                        );
                        const hasBlockingErrors = this.hasBlockingErrors(ruleIssues, ruleActionMap);
                        if (hasBlockingErrors) {
                            this.logger.warn('检测到阻止提交错误，已跳过AI审查');
                        } else {
                            aiIssues = await runAiReview();
                        }
                    } else {
                        aiIssues = await runAiReview();
                    }
                } else {
                    const aiPromise = runAiReview();
                    if (builtinRulesEnabled) {
                        ruleIssues = await this.ruleEngine.checkFiles(
                            filteredFiles,
                            useRuleDiff ? options?.diffByFile : undefined,
                            traceSession
                        );
                    }
                    aiIssues = await aiPromise;
                }
            } else if (builtinRulesEnabled) {
                ruleIssues = await this.ruleEngine.checkFiles(
                    filteredFiles,
                    useRuleDiff ? options?.diffByFile : undefined,
                    traceSession
                );
            }

            const allIssues = IssueDeduplicator.mergeAndDeduplicate(ruleIssues, aiIssues, aiErrorIssues);
            this.attachAstRanges(allIssues, astSnippetsByFile);
            for (const issue of allIssues) {
                switch (issue.severity) {
                    case 'error':
                        result.errors.push(issue);
                        break;
                    case 'warning':
                        result.warnings.push(issue);
                        break;
                    case 'info':
                        result.info.push(issue);
                        break;
                }
            }

            const hasBlockingErrors = this.hasBlockingErrors(result.errors, ruleActionMap);
            if (config.rules.strict_mode) {
                result.passed = result.errors.length === 0;
            } else {
                result.passed = !hasBlockingErrors;
            }

            this.logger.info('审查流程完成');
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'ReviewEngine',
                event: 'run_end',
                phase: 'review',
                durationMs: Date.now() - reviewStartAt,
                data: { status: 'success' },
            });
            await this.generateRuntimeSummaryIfEnabled(traceSession, config);
            return result;
        } catch (error) {
            const errorClass = error instanceof Error ? error.name : 'UnknownError';
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'ReviewEngine',
                event: 'run_end',
                phase: 'review',
                durationMs: Date.now() - reviewStartAt,
                level: 'error',
                data: {
                    status: 'failed',
                    errorClass,
                },
            });
            await this.generateRuntimeSummaryIfEnabled(traceSession, config);
            throw error;
        } finally {
            if (ownTraceSession) {
                this.runtimeTraceLogger.endRunSession(traceSession);
            }
        }
    }

    /**
     * 判断是否存在阻止提交的错误
     *
     * @param issues - 问题列表
     * @param ruleActionMap - 规则与 action 的映射
     * @returns 是否存在阻止提交的错误
     */
    private hasBlockingErrors = (
        issues: ReviewIssue[],
        ruleActionMap: Map<string, 'block_commit' | 'warning' | 'log' | undefined>
    ): boolean => {
        return issues.some(issue => {
            const action = ruleActionMap.get(issue.rule);
            return action === 'block_commit';
        });
    };

    /**
     * 根据 AST 片段结果补充问题的范围信息
     * 
     * @param issues - 需要补充范围的问题列表
     * @param astSnippetsByFile - AST 片段结果（按文件）
     */
    private attachAstRanges = (
        issues: ReviewIssue[],
        astSnippetsByFile?: Map<string, AffectedScopeResult>
    ): void => {
        if (!astSnippetsByFile || issues.length === 0) {
            return;
        }
        for (const issue of issues) {
            if (issue.astRange) {
                continue;
            }
            const astResult = astSnippetsByFile.get(issue.file);
            if (!astResult?.snippets?.length) {
                continue;
            }
            const candidates = astResult.snippets.filter(snippet =>
                issue.line >= snippet.startLine && issue.line <= snippet.endLine
            );
            if (candidates.length === 0) {
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
        }
    };

    /**
     * 按配置自动生成可读运行摘要（失败不影响主流程）
     */
    private generateRuntimeSummaryIfEnabled = async (
        session: RuntimeTraceSession | null | undefined,
        config: ReturnType<ConfigManager['getConfig']>
    ): Promise<void> => {
        if (!session) {
            return;
        }
        const humanReadable = config.runtime_log?.human_readable;
        if (!humanReadable?.enabled || !humanReadable.auto_generate_on_run_end) {
            return;
        }
        const runLogFile = this.runtimeTraceLogger.getRunLogFilePath(session);
        if (!runLogFile) {
            return;
        }
        try {
            await this.runtimeTraceLogger.flush();
            await generateRuntimeSummaryForFile(runLogFile, {
                granularity: humanReadable.granularity ?? 'summary_with_key_events',
            });
        } catch (error) {
            this.logger.warn('自动生成运行日志摘要失败', error);
        }
    };

    /**
     * 审查 Git staged 文件
     * 
     * 这是最常用的审查方法，会自动获取所有已暂存（staged）的文件
     * 通常在以下场景调用：
     * - 用户手动触发审查命令
     * - Git pre-commit hook 执行时
     * 
     * @returns 审查结果对象
     */
    async reviewStagedFiles(): Promise<ReviewResult> {
        this.logger.show();
        const config = this.configManager.getConfig();
        this.runtimeTraceLogger.applyConfig(config.runtime_log);
        Logger.setInfoOutputEnabled(this.runtimeTraceLogger.shouldOutputInfoToChannel());
        const traceSession = this.runtimeTraceLogger.startRunSession('staged');

        const stagedFiles = await this.fileScanner.getStagedFiles();
        if (stagedFiles.length === 0) {
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'ReviewEngine',
                event: 'run_start',
                phase: 'staged',
                data: { inputFiles: 0, trigger: 'staged' },
            });
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'ReviewEngine',
                event: 'run_end',
                phase: 'staged',
                durationMs: 0,
                data: { status: 'success' },
            });
            await this.generateRuntimeSummaryIfEnabled(traceSession, config);
            this.runtimeTraceLogger.endRunSession(traceSession);
            return {
                passed: true,
                errors: [],
                warnings: [],
                info: []
            };
        }

        const useDiff = config.rules.diff_only !== false || config.ai_review?.diff_only !== false;
        let diffByFile: Map<string, FileDiff> | undefined;
        const diffStartAt = Date.now();
        if (useDiff) {
            diffByFile = await this.fileScanner.getStagedDiff(stagedFiles);
        }
        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'ReviewEngine',
            event: 'diff_fetch_summary',
            phase: 'staged',
            durationMs: Date.now() - diffStartAt,
            data: {
                stagedFiles: stagedFiles.length,
                useDiff,
                diffFiles: diffByFile?.size ?? 0,
            },
        });

        try {
            return await this.review(stagedFiles, { diffByFile, traceSession });
        } finally {
            this.runtimeTraceLogger.endRunSession(traceSession);
        }
    }
}
