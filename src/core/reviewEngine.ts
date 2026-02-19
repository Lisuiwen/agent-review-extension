/**
 * 审查引擎
 * 
 * 这是整个插件的核心组件，负责协调各个子系统完成代码审查
 * 
 * 主要职责：
 * 1. 接收文件列表，执行代码审查
 * 2. 根据配置决定是否调用内置规则引擎检查代码问题
 * 3. 调用AI审查器进行AI代码审查（如果启用）
 * 4. 读取编辑器 Diagnostics，供 AI 白名单与后置去重使用
 * 5. 根据 diff 给问题打“增量/存量”标签，驱动侧边栏分栏展示
 * 6. 根据配置决定是否阻止提交
 * 7. 返回结构化的审查结果
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
import * as vscode from 'vscode';
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
     * 应用运行链路日志配置，并同步控制台输出策略
     */
    private applyRuntimeTraceConfig = (config: ReturnType<ConfigManager['getConfig']>): void => {
        this.runtimeTraceLogger.applyConfig(config.runtime_log);
        Logger.setInfoOutputEnabled(this.runtimeTraceLogger.shouldOutputInfoToChannel());
    };

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
        if (!options?.traceSession) {
            this.applyRuntimeTraceConfig(config);
        }
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
                aiRunOnSave: config.ai_review?.run_on_save ?? false,
                aiFunnelLint: config.ai_review?.funnel_lint ?? false,
                aiFunnelLintSeverity: config.ai_review?.funnel_lint_severity ?? 'error',
                aiIgnoreFormatOnlyDiff: config.ai_review?.ignore_format_only_diff ?? true,
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
            const diagnosticsByFile = this.collectDiagnosticsByFile(filteredFiles);
            const aiInputFiles = this.filterFilesForAiReview({
                files: filteredFiles,
                diffByFile: options?.diffByFile,
                diagnosticsByFile,
                aiConfig: config.ai_review,
            });
            const runAiReview = async (): Promise<ReviewIssue[]> => {
                if (!config.ai_review?.enabled) {
                    return [];
                }
                if (aiInputFiles.length === 0) {
                    this.logger.info('AI 审查已跳过：当前没有满足条件的文件（可能被漏斗或格式化降噪过滤）');
                    return [];
                }

                try {
                    const astSnippetsByFile = await ensureAstSnippetsByFile();
                    const aiRequest = {
                        files: aiInputFiles.map(file => ({ path: file })),
                        diffByFile: useAiDiff ? options!.diffByFile : undefined,
                        astSnippetsByFile,
                        diagnosticsByFile: this.pickDiagnosticsForFiles(diagnosticsByFile, aiInputFiles),
                    };
                    return await this.aiReviewer.review(aiRequest, traceSession);
                } catch (error) {
                    this.logger.error('AI审查失败', error);
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

            const builtinRulesEnabled = config.rules.builtin_rules_enabled !== false && config.rules.enabled;
            const skipOnBlocking = config.ai_review?.skip_on_blocking_errors !== false;
            const aiEnabled = config.ai_review?.enabled ?? false;

            const runRuleEngine = () => this.ruleEngine.checkFiles(
                filteredFiles,
                useRuleDiff ? options?.diffByFile : undefined,
                traceSession
            );

            if (aiEnabled) {
                if (skipOnBlocking && builtinRulesEnabled) {
                    ruleIssues = await runRuleEngine();
                    if (this.hasBlockingErrors(ruleIssues, ruleActionMap)) {
                        this.logger.warn('检测到阻止提交错误，已跳过AI审查');
                    } else {
                        aiIssues = await runAiReview();
                    }
                } else if (skipOnBlocking) {
                    aiIssues = await runAiReview();
                } else {
                    const [ruleResult, aiResult] = await Promise.all([
                        builtinRulesEnabled ? runRuleEngine() : Promise.resolve([]),
                        runAiReview(),
                    ]);
                    ruleIssues = ruleResult;
                    aiIssues = aiResult;
                }
            } else if (builtinRulesEnabled) {
                ruleIssues = await runRuleEngine();
            }

            const deduplicatedIssues = IssueDeduplicator.mergeAndDeduplicate(ruleIssues, aiIssues, aiErrorIssues);
            const allIssues = await this.filterIgnoredIssues(deduplicatedIssues);
            this.attachAstRanges(allIssues, astSnippetsByFile);
            this.markIncrementalIssues(allIssues, options?.diffByFile);
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
    ): boolean => issues.some(issue => ruleActionMap.get(issue.rule) === 'block_commit');

    /** 将 action 配置映射为 issue 的 severity */
    private actionToSeverity = (action: 'block_commit' | 'warning' | 'log'): 'error' | 'warning' | 'info' => {
        if (action === 'block_commit') return 'error';
        if (action === 'log') return 'info';
        return 'warning';
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
     * 读取当前文件的 VSCode diagnostics，并按文件归档。
     *
     * 说明：
     * - 这里的数据用于 AI 去重白名单与后置过滤，不影响规则引擎本身。
     * - 读取失败或 API 不可用时返回空映射，主流程不受影响。
     */
    private collectDiagnosticsByFile = (
        files: string[]
    ): Map<string, Array<{ line: number; message: string; severity: 'error' | 'warning' | 'info' | 'hint' }>> => {
        const map = new Map<string, Array<{ line: number; message: string; severity: 'error' | 'warning' | 'info' | 'hint' }>>();
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
                            message: item.message,
                            severity: this.toDiagnosticSeverity(item.severity),
                        }))
                    );
                } catch {
                    // diagnostics 读取失败时忽略，避免影响主流程
                }
            }
            return map;
        } catch {
            return map;
        }
    };

    /**
     * 将 VSCode DiagnosticSeverity 统一成字符串，便于日志与配置判断。
     */
    private toDiagnosticSeverity = (
        severity: vscode.DiagnosticSeverity | undefined
    ): 'error' | 'warning' | 'info' | 'hint' => {
        if (severity === vscode.DiagnosticSeverity.Error) return 'error';
        if (severity === vscode.DiagnosticSeverity.Warning) return 'warning';
        if (severity === vscode.DiagnosticSeverity.Information) return 'info';
        return 'hint';
    };

    private pickDiagnosticsForFiles = (
        diagnosticsByFile: Map<string, Array<{ line: number; message: string; severity: 'error' | 'warning' | 'info' | 'hint' }>>,
        filePaths: string[]
    ): Map<string, Array<{ line: number; message: string }>> => {
        const picked = new Map<string, Array<{ line: number; message: string }>>();
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
            picked.set(filePath, diagnostics.map(item => ({ line: item.line, message: item.message })));
        }
        return picked;
    };

    /**
     * AI 审查前过滤：
     * 1) 漏斗式检测：按 diagnostics 严重级别跳过文件
     * 2) 格式化降噪：diff 模式下跳过仅格式/空白变更文件
     */
    private filterFilesForAiReview = (params: {
        files: string[];
        diffByFile?: Map<string, FileDiff>;
        diagnosticsByFile: Map<string, Array<{ line: number; message: string; severity: 'error' | 'warning' | 'info' | 'hint' }>>;
        aiConfig?: ReturnType<ConfigManager['getConfig']>['ai_review'];
    }): string[] => {
        const {
            files,
            diffByFile,
            diagnosticsByFile,
            aiConfig,
        } = params;
        const enableFunnel = aiConfig?.funnel_lint === true;
        const funnelSeverity = aiConfig?.funnel_lint_severity ?? 'error';
        const ignoreFormatOnlyDiff = aiConfig?.ignore_format_only_diff !== false;

        return files.filter(filePath => {
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
                    return false;
                }
            }

            if (ignoreFormatOnlyDiff && diffByFile) {
                const fileDiff = diffByFile.get(normalizedPath) ?? diffByFile.get(filePath);
                if (fileDiff?.formatOnly === true) {
                    return false;
                }
            }

            return true;
        });
    };

    /**
     * 识别并过滤「@ai-ignore」覆盖的问题。
     *
     * 规则：
     * - 标记行本身忽略
     * - 标记行后的首个非空行也忽略（覆盖常见“注释写在问题上方一行”的场景）
     */
    private filterIgnoredIssues = async (issues: ReviewIssue[]): Promise<ReviewIssue[]> => {
        if (issues.length === 0) {
            return issues;
        }

        const issueFiles = Array.from(new Set(issues.map(item => path.normalize(item.file))));
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
                // 文件读取失败时不做忽略过滤，避免误吞问题
            }
        }));

        if (ignoredLinesByFile.size === 0) {
            return issues;
        }

        const filtered = issues.filter(issue => {
            const ignoredLines = ignoredLinesByFile.get(path.normalize(issue.file));
            return !ignoredLines?.has(issue.line);
        });
        if (filtered.length < issues.length) {
            this.logger.info(`已过滤 ${issues.length - filtered.length} 条 @ai-ignore 标记的问题`);
        }
        return filtered;
    };

    /**
     * 基于 diff 行集合给 issue 打「增量 / 存量」标签，用于侧边栏分栏显示。
     */
    private markIncrementalIssues = (issues: ReviewIssue[], diffByFile?: Map<string, FileDiff>): void => {
        if (issues.length === 0) {
            return;
        }
        // 无 diff 场景（如整文件手动审查）默认都视为本次增量，避免全部落入“存量”分栏。
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
        this.applyRuntimeTraceConfig(config);
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

    /**
     * 审查指定文件，并使用 working diff（未暂存变更）作为增量范围。
     *
     * 主要用于“保存触发审查”：
     * - 文件尚未 staged 时，也能命中 diff_only / formatOnly 降噪逻辑
     * - 不触发新的 staged 扫描，避免保存场景拉入无关文件
     */
    async reviewFilesWithWorkingDiff(files: string[]): Promise<ReviewResult> {
        const config = this.configManager.getConfig();
        this.applyRuntimeTraceConfig(config);
        const traceSession = this.runtimeTraceLogger.startRunSession('manual');
        const normalizedFiles = files.map(file => path.normalize(file));

        if (normalizedFiles.length === 0) {
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'ReviewEngine',
                event: 'run_start',
                phase: 'manual',
                data: { inputFiles: 0, trigger: 'save' },
            });
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'ReviewEngine',
                event: 'run_end',
                phase: 'manual',
                durationMs: 0,
                data: { status: 'success' },
            });
            await this.generateRuntimeSummaryIfEnabled(traceSession, config);
            this.runtimeTraceLogger.endRunSession(traceSession);
            return {
                passed: true,
                errors: [],
                warnings: [],
                info: [],
            };
        }

        const useDiff = config.rules.diff_only !== false || config.ai_review?.diff_only !== false;
        let diffByFile: Map<string, FileDiff> | undefined;
        const diffStartAt = Date.now();
        if (useDiff) {
            diffByFile = await this.fileScanner.getWorkingDiff(normalizedFiles);
        }
        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'ReviewEngine',
            event: 'diff_fetch_summary',
            phase: 'manual',
            durationMs: Date.now() - diffStartAt,
            data: {
                workingFiles: normalizedFiles.length,
                useDiff,
                diffFiles: diffByFile?.size ?? 0,
            },
        });

        try {
            return await this.review(normalizedFiles, { diffByFile, traceSession });
        } finally {
            this.runtimeTraceLogger.endRunSession(traceSession);
        }
    }
}
