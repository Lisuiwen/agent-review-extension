/**
 * 瀹℃煡寮曟搸
 *
 * 娴佺▼姒傝锛?
 * 1. 鏍规嵁閰嶇疆杩囨护銆佹帓闄ょ殑鏂囦欢
 * 2. 鏍规嵁閰嶇疆杩囨护鎺掗櫎鐨勬枃浠?
 * 3. 璋冪敤 AI 瀹℃煡鍣ㄨ繘琛?AI 浠ｇ爜瀹℃煡锛堣嫢鍚敤锛?
 * 6. 鏍规嵁閰嶇疆鍐冲畾鏄惁闃绘鎻愪氦
 * 7. 杩斿洖缁撴瀯鍖栫殑瀹℃煡缁撴灉
 *
 * - 濡傛灉椤圭洰宸叉湁鑷繁鐨勮鍒欏紩鎿庯紝寤鸿淇濇寔 builtin_rules_enabled: false
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
import { RuntimeTraceLogger, type RuntimeTraceSession, type RunSummaryPayload } from '../utils/runtimeTraceLogger';
import { computeIssueFingerprint } from '../utils/issueFingerprint';
import { loadIgnoredFingerprints } from '../config/ignoreStore';
import { formatTimeHms } from '../utils/runtimeLogExplainer';
import type { ReviewRunOptions, ReviewContextOptions, ReviewedRange, SavedFileReviewContext, PendingReviewContext, StagedReviewContext, ProjectDiagnosticItem, ReviewScopeHint } from './reviewEngine.types';
import { buildRunSummaryPayload } from './reviewEngine.runSummary';
import { getEffectiveWorkspaceRoot, getWorkspaceFolderByFile } from '../utils/workspaceRoot';

export type { ReviewIssue, ReviewResult } from '../types/review';

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
     * 鍒濆鍖栧鏌ュ紩鎿庡強鍏朵緷璧栫殑缁勪欢
     *
     * @param configManager - 閰嶇疆绠＄悊鍣紝鐢ㄤ簬璇诲彇瀹℃煡瑙勫垯閰嶇疆
     */
    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
        this.logger = new Logger('ReviewEngine');
        this.ruleEngine = new RuleEngine(configManager);
        // AI 瀹℃煡鍣細鐢ㄤ簬 AI 浠ｇ爜瀹℃煡
        this.aiReviewer = new AIReviewer(configManager);
        this.fileScanner = new FileScanner();
        this.runtimeTraceLogger = RuntimeTraceLogger.getInstance();
    }

    /**
     * 鑻ラ厤缃惎鐢?AI 瀹℃煡锛屽垯鍒濆鍖?AI 瀹℃煡鍣ㄣ€?
     */
    async initialize(): Promise<void> {
        const config = this.configManager.getConfig();
        if (config.ai_review?.enabled) {
            await this.aiReviewer.initialize();
        }
    }

    /**
     * 搴旂敤杩愯鏃舵棩蹇楅厤缃苟鍚屾 Logger 鏄惁杈撳嚭鍒伴€氶亾銆?
     */
    private applyRuntimeTraceConfig = (config: ReturnType<ConfigManager['getConfig']>): void => {
        this.runtimeTraceLogger.applyConfig(config.runtime_log);
        Logger.setInfoOutputEnabled(this.runtimeTraceLogger.shouldOutputInfoToChannel());
    };

    /**
     * 瀵规寚瀹氭枃浠舵墽琛岃鍒?+ AI 瀹℃煡锛屾敮鎸?diff/ast 绛夐€夐」銆?
     * @param files - 瑕佸鏌ョ殑鏂囦欢璺緞鏁扮粍
     * @returns 瀹℃煡缁撴灉瀵硅薄
     */
    async review(
        files: string[],
        options?: ReviewRunOptions
    ): Promise<ReviewResult> {
        this.logger.show();
        const reviewStartAt = Date.now();
        const result = this.createEmptyReviewResult();

        const config = this.configManager.getConfig();
        if (!options?.traceSession) {
            this.applyRuntimeTraceConfig(config);
        }
        const ownTraceSession = !options?.traceSession;
        const traceSession =
            options?.traceSession ?? this.runtimeTraceLogger.startRunSession(options?.diffByFile ? 'staged' : 'manual');

        const workspaceRoot = options?.workspaceRoot ?? getEffectiveWorkspaceRoot()?.uri.fsPath ?? '';
        try {
            const writeRunSummaryIfNeeded = async (
                status: 'success' | 'failed',
                opts: { errorClass?: string; ignoredByFingerprintCount: number; allowedByLineCount: number; ignoreAllowEvents?: RunSummaryPayload['ignoreAllowEvents'] }
            ): Promise<void> => {
                if (!traceSession) return;
                const { payload, logDateMs } = await buildRunSummaryPayload(
                    traceSession,
                    result,
                    status,
                    opts,
                    workspaceRoot,
                    reviewStartAt
                );
                this.runtimeTraceLogger.writeRunSummary(traceSession, payload, logDateMs);
            };
            const emptySummaryOpts = { ignoredByFingerprintCount: 0, allowedByLineCount: 0 };

            if (files.length === 0) {
                await writeRunSummaryIfNeeded('success', emptySummaryOpts);
                return result;
            }

            const exclusions = config.exclusions;
            const filteredFiles = exclusions
                ? files.filter(file => !this.fileScanner.shouldExclude(file, exclusions))
                : [...files];

            if (filteredFiles.length === 0) {
                await writeRunSummaryIfNeeded('success', emptySummaryOpts);
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
                const diffByFile = options.diffByFile;

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

                const filesWithDiff = targetFiles.filter((filePath) => {
                    const normalizedPath = path.normalize(filePath);
                    const fileDiff = diffByFile.get(normalizedPath) ?? diffByFile.get(filePath);
                    return !!fileDiff?.hunks?.length;
                });

                const processOne = async (filePath: string): Promise<{ filePath: string; scopeResult: ReturnType<typeof getAffectedScopeWithDiagnostics> }> => {
                    const fileDiff = diffByFile.get(path.normalize(filePath)) ?? diffByFile.get(filePath)!;
                    try {
                        const content = await this.fileScanner.readFile(filePath);
                        const scopeResult = getAffectedScopeWithDiagnostics(filePath, content, fileDiff, {
                            maxFileLines: config.ast?.max_file_lines,
                            maxNodeLines: config.ast?.max_node_lines,
                            mergeSnippetGapLines: config.ast?.merge_snippet_gap_lines ?? 1,
                        });
                        return { filePath, scopeResult };
                    } catch {
                        return { filePath, scopeResult: { result: null, fallbackReason: 'parseFailed' as const } };
                    }
                };

                const concurrency = config.ast?.slice_concurrency ?? 4;
                if (concurrency <= 1) {
                    for (const filePath of filesWithDiff) {
                        attemptedFiles++;
                        const { filePath: fp, scopeResult } = await processOne(filePath);
                        if (scopeResult.result?.snippets?.length) {
                            snippetsByFile.set(fp, scopeResult.result);
                        } else {
                            addFallback(scopeResult.fallbackReason);
                        }
                    }
                } else {
                    for (let i = 0; i < filesWithDiff.length; i += concurrency) {
                        const chunk = filesWithDiff.slice(i, i + concurrency);
                        const results = await Promise.all(chunk.map(processOne));
                        for (const { filePath: fp, scopeResult } of results) {
                            attemptedFiles++;
                            if (scopeResult.result?.snippets?.length) {
                                snippetsByFile.set(fp, scopeResult.result);
                            } else {
                                addFallback(scopeResult.fallbackReason);
                            }
                        }
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
                    this.logger.info('AI 瀹℃煡宸茶烦杩囷細褰撳墠娌℃湁婊¤冻鏉′欢鐨勬枃浠讹紙鍙兘琚牸寮忔垨婕忔枟杩囨护鎺夛級');
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
                    this.logger.error('AI 瀹℃煡澶辫触', error);
                    const message = error instanceof Error ? error.message : String(error);
                    const severity = this.actionToSeverity(config.ai_review?.action ?? 'warning');
                    const isTimeout = /timeout|瓒呮椂/i.test(message);
                    aiErrorIssues.push({
                        file: '',
                        line: 1,
                        column: 1,
                        message: isTimeout ? `AI瀹℃煡瓒呮椂: ${message}` : `AI瀹℃煡澶辫触: ${message}`,
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

            // 鍥哄畾椤哄簭锛氳鍒欓樁娈?->锛堢‖璺宠繃鍒ゆ柇锛?> AI 闃舵
            ruleIssues = await runRules();
            if (aiEnabled) {
                if (skipOnBlocking && this.hasBlockingErrors(ruleIssues, ruleActionMap)) {
                    this.logger.warn('妫€娴嬪埌闃绘柇绾ц鍒欓棶棰橈紝宸茶烦杩嘇I瀹℃煡');
                } else {
                    aiIssues = await runAiReview();
                }
            }

            const deduplicatedIssues = IssueDeduplicator.mergeAndDeduplicate(ruleIssues, aiIssues, aiErrorIssues);
            if (workspaceRoot) {
                for (const issue of deduplicatedIssues) {
                    if (!issue.workspaceRoot) {
                        issue.workspaceRoot = workspaceRoot;
                    }
                }
            }
            if (workspaceRoot) {
                for (const issue of deduplicatedIssues) {
                    if (issue.fingerprint) continue;
                    const normalized = issue.file ? path.normalize(issue.file) : '';
                    if (!normalized || normalized === '.' || normalized === '..') continue;
                    try {
                        const content = await this.fileScanner.readFile(issue.file);
                        issue.fingerprint = computeIssueFingerprint(issue, content, workspaceRoot);
                    } catch {
                        // 鏂囦欢璇诲彇澶辫触鍒欒烦杩囪鏉℃寚绾癸紝杩囨护鏃朵笉浼氭寜鎸囩汗鍘婚噸
                    }
                }
            }
            const { issues: allIssues, ignoredByFingerprintCount, allowedByLineCount, ignoreAllowEvents } = await this.filterIgnoredIssues(deduplicatedIssues, workspaceRoot);
            this.attachAstRanges(allIssues, astSnippetsByFile);
            const incrementalOnly = this.filterIncrementalIssues(allIssues, options?.diffByFile);
            for (const issue of incrementalOnly) {
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

            this.logger.info('瀹℃煡娴佺▼瀹屾垚');
            await writeRunSummaryIfNeeded('success', { ignoredByFingerprintCount, allowedByLineCount, ignoreAllowEvents });
            return result;
        } catch (error) {
            const errorClass = error instanceof Error ? error.name : 'UnknownError';
            if (traceSession) {
                const { payload, logDateMs } = await buildRunSummaryPayload(
                    traceSession,
                    this.createEmptyReviewResult(),
                    'failed',
                    { errorClass, ignoredByFingerprintCount: 0, allowedByLineCount: 0, ignoreAllowEvents: [] },
                    workspaceRoot,
                    reviewStartAt
                );
                this.runtimeTraceLogger.writeRunSummary(traceSession, payload, logDateMs);
            }
            throw error;
        } finally {
            if (ownTraceSession) {
                this.runtimeTraceLogger.endRunSession(traceSession);
            }
        }
    }

    /**
     * 鍒ゆ柇闂鍒楄〃涓槸鍚﹀瓨鍦ㄦ寜瑙勫垯闇€闃绘柇鎻愪氦鐨勯」锛坧roject_rule 鐪?error锛屽叾浣欑湅 ruleActionMap锛夈€?
     * @param issues - 闂鍒楄〃
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
     * 鏍规嵁 astSnippetsByFile 涓洪棶棰樿ˉ鍏?astRange锛堝彇鍖呭惈闂琛屽彿鐨勬渶灏忕墖娈碉級銆?
     * @param issues - 闇€瑕佽ˉ鍏呰寖鍥寸殑闂鍒楄〃
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
     * 浠?VSCode 璇█鏈嶅姟鏀堕泦鍚勬枃浠剁殑璇婃柇淇℃伅锛屽苟瑙勮寖鍖栦负琛屽彿銆佷弗閲嶇▼搴︾瓑銆?
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

    /** 灏?VSCode DiagnosticSeverity 杞负缁熶竴瀛楃涓诧紝渚?project rule 涓庢紡鏂楅€昏緫浣跨敤 */
    private toDiagnosticSeverity = (severity: vscode.DiagnosticSeverity | undefined): 'error' | 'warning' | 'info' | 'hint' => {
        const map: Record<number, 'error' | 'warning' | 'info' | 'hint'> = {
            [vscode.DiagnosticSeverity.Error]: 'error',
            [vscode.DiagnosticSeverity.Warning]: 'warning',
            [vscode.DiagnosticSeverity.Information]: 'info',
        };
        return map[severity ?? -1] ?? 'hint';
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
     * AI 瀹℃煡鍓嶈繃婊わ細鏍煎紡婕忔枟锛歞iff 妯″紡涓嬭烦杩囦粎鏍煎紡/绌虹櫧鍙樻洿鏂囦欢
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
     * 璇嗗埆骞惰繃婊ゅ凡蹇界暐鐨勯棶棰樸€傞『搴忎笉鍙鍊掞細
     * 1) 鍏堟寜椤圭洰绾у拷鐣ユ寚绾硅繃婊わ紱2) 鍐嶆寜 @ai-ignore 琛屽彿杩囨护锛堟爣璁拌鍙婁笅涓€闈炵┖琛岋級銆?
     * 杩斿洖杩囨护鍚庣殑闂鍒楄〃銆佹暟閲忓強鏀捐/蹇界暐浜嬩欢鍒楄〃锛堟瘡鏉″甫鏃跺垎绉掞級锛屼緵杩愯姹囨€荤粺璁＄敤銆?
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

        const resolveIssueWorkspaceRoot = (issue: ReviewIssue): string =>
            issue.workspaceRoot || workspaceRoot || '';
        const roots = Array.from(
            new Set(
                issues
                    .map(resolveIssueWorkspaceRoot)
                    .filter(root => root.length > 0)
            )
        );
        if (roots.length > 0) {
            const ignoredByRoot = new Map<string, Set<string>>();
            await Promise.all(
                roots.map(async root => {
                    ignoredByRoot.set(root, new Set(await loadIgnoredFingerprints(root)));
                })
            );
            const ignoredByFp = issues.filter(issue => {
                if (!issue.fingerprint) return false;
                const root = resolveIssueWorkspaceRoot(issue);
                if (!root) return false;
                const ignoredSet = ignoredByRoot.get(root);
                return !!ignoredSet?.has(issue.fingerprint);
            });
            afterFingerprint = issues.filter(issue => {
                if (!issue.fingerprint) return true;
                const root = resolveIssueWorkspaceRoot(issue);
                if (!root) return true;
                const ignoredSet = ignoredByRoot.get(root);
                return !ignoredSet?.has(issue.fingerprint);
            });
            ignoredByFingerprintCount = ignoredByFp.length;
            if (ignoredByFingerprintCount > 0) {
                this.logger.info(`宸叉寜鎸囩汗杩囨护 ${ignoredByFingerprintCount} 鏉￠」鐩骇蹇界暐闂`);
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

        const issueFiles = Array.from(
            new Set(
                afterFingerprint
                    .map((item) => path.normalize(item.file))
                    .filter((p) => p && p !== '.' && p !== '..')
            )
        );
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
                // 鏂囦欢璇诲彇澶辫触鏃朵笉鍋氳繃婊わ紝閬垮厤璇垽闂
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
     * 鏍规嵁 diffByFile 杩囨护鍑烘湰娆″彉鏇磋涓婄殑闂锛涙棤 diff 鏃惰繑鍥炲叏閮ㄩ棶棰樸€傜粨鏋滀腑鍙惈澧為噺锛屼緵鍐欏叆 result銆?
     */
    private filterIncrementalIssues = (issues: ReviewIssue[], diffByFile?: Map<string, FileDiff>): ReviewIssue[] => {
        if (issues.length === 0) return [];
        if (!diffByFile || diffByFile.size === 0) return [...issues];
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
        return issues.filter(issue => {
            const lines = changedLinesByFile.get(path.normalize(issue.file));
            return !!lines?.has(issue.line);
        });
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

    /** 姣忔杩斿洖鏂扮殑绌虹粨鏋滃璞★紙鏂版暟缁勶級锛岄伩鍏嶅叡浜紩鐢ㄨ姹℃煋 */
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
        reason: string,
        workspaceRoot?: string
    ): Promise<ReviewResult> => {
        return await this.review([filePath], { traceSession, workspaceRoot });
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
        const workspaceRoot =
            getWorkspaceFolderByFile(normalizedFilePath)?.uri.fsPath
            ?? getEffectiveWorkspaceRoot()?.uri.fsPath;

        try {
            if (!normalizedFilePath) {
                return this.createEmptyReviewResult();
            }
            if (normalizedScopes.length === 0) {
                return await this.fallbackToFullFileReview(
                    normalizedFilePath,
                    traceSession,
                    'scope_hint_fallback_empty_or_invalid_scopes',
                    workspaceRoot
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
                        'scope_hint_fallback_empty_snippets_after_bounding',
                        workspaceRoot
                    );
                }
                const scopeResult = await this.review([normalizedFilePath], {
                    diffByFile: artifacts.diffByFile,
                    astSnippetsByFileOverride: artifacts.astSnippetsByFile,
                    traceSession,
                    workspaceRoot,
                });
                if (this.countReviewIssues(scopeResult) > 0) {
                    return scopeResult;
                }

                return await this.fallbackToFullFileReview(
                    normalizedFilePath,
                    traceSession,
                    'scope_hint_empty_result_fallback_full_file',
                    workspaceRoot
                );
            } catch {
                return await this.fallbackToFullFileReview(
                    normalizedFilePath,
                    traceSession,
                    'scope_hint_fallback_read_file_failed',
                    workspaceRoot
                );
            }
        } finally {
            this.runtimeTraceLogger.endRunSession(traceSession);
        }
    }

    /**
     * 瀹℃煡 Git staged 鏂囦欢
     *
     * 杩欐槸鏈€甯哥敤鐨勫鏌ユ柟娉曪紝浼氳嚜鍔ㄨ幏鍙栨墍鏈夊凡鏆傚瓨锛坰taged锛夌殑鏂囦欢
     * 閫氬父鍦ㄤ互涓嬪満鏅皟鐢細
     * - 鐢ㄦ埛鎵嬪姩瑙﹀彂瀹℃煡鍛戒护
     *
     * @returns 瀹℃煡缁撴灉瀵硅薄
     */
    async reviewPendingChangesWithContext(options?: ReviewContextOptions): Promise<PendingReviewContext> {
        this.logger.show();
        const config = this.configManager.getConfig();
        this.applyRuntimeTraceConfig(config);
        const traceSession = this.runtimeTraceLogger.startRunSession('manual');

        try {
            const useDiff = config.rules.diff_only !== false || config.ai_review?.diff_only !== false;
            const workspaceRoot = options?.workspaceRoot ?? getEffectiveWorkspaceRoot()?.uri.fsPath;
            const pendingDiffByFile = await this.fileScanner.getPendingDiff(workspaceRoot);
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
                result: await this.review(pendingFiles, { diffByFile, traceSession, workspaceRoot }),
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

    async reviewSavedFileWithPendingDiffContext(
        filePath: string,
        options?: ReviewContextOptions
    ): Promise<SavedFileReviewContext> {
        const config = this.configManager.getConfig();
        this.applyRuntimeTraceConfig(config);
        const traceSession = this.runtimeTraceLogger.startRunSession('manual');
        const normalizedFilePath = path.normalize(filePath);
        const workspaceRoot =
            options?.workspaceRoot
            ?? getWorkspaceFolderByFile(normalizedFilePath)?.uri.fsPath
            ?? getEffectiveWorkspaceRoot()?.uri.fsPath;

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
                const pendingDiffByFile = await this.fileScanner.getPendingDiff(workspaceRoot, [normalizedFilePath]);
                const matchedDiffEntry = Array.from(pendingDiffByFile.entries()).find(
                    ([key]) => path.normalize(key) === normalizedFilePath
                );
                const matchedDiff = matchedDiffEntry?.[1];
                if (!matchedDiff || matchedDiff.hunks.length === 0) {
                    return {
                        result: await this.fallbackToFullFileReview(
                            normalizedFilePath,
                            traceSession,
                            'pending_diff_fallback_empty_or_invalid_diff',
                            workspaceRoot
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
                        workspaceRoot,
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
                        'pending_diff_fallback_fetch_failed',
                        workspaceRoot
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

    async reviewSavedFileWithPendingDiff(filePath: string, options?: ReviewContextOptions): Promise<ReviewResult> {
        const context = await this.reviewSavedFileWithPendingDiffContext(filePath, options);
        return context.result;
    }

    async reviewStagedFiles(): Promise<ReviewResult> {
        const ctx = await this.reviewStagedFilesWithContext();
        return ctx.result;
    }

    async reviewStagedFilesWithContext(options?: ReviewContextOptions): Promise<StagedReviewContext> {
        this.logger.show();
        const config = this.configManager.getConfig();
        this.applyRuntimeTraceConfig(config);
        const traceSession = this.runtimeTraceLogger.startRunSession('staged');

        try {
            const workspaceRoot = options?.workspaceRoot ?? getEffectiveWorkspaceRoot()?.uri.fsPath;
            const stagedFiles = await this.fileScanner.getStagedFiles(workspaceRoot);
            const normalizedStaged = stagedFiles.map((f) => path.normalize(f));
            if (normalizedStaged.length === 0) {
                const result = await this.completeEmptyRun(traceSession, config, 'staged', 'staged');
                return { result, stagedFiles: [] };
            }

            const useDiff = config.rules.diff_only !== false || config.ai_review?.diff_only !== false;
            let diffByFile: Map<string, FileDiff> | undefined;
            if (useDiff) {
                diffByFile = await this.fileScanner.getStagedDiff(workspaceRoot, normalizedStaged);
            }

            const result = await this.review(normalizedStaged, { diffByFile, traceSession, workspaceRoot });
            return { result, stagedFiles: normalizedStaged };
        } finally {
            this.runtimeTraceLogger.endRunSession(traceSession);
        }
    }

    /**
     *
     * 涓昏鐢ㄤ簬銆屼繚瀛樿Е鍙戝鏌ャ€嶏細
     * - 鏂囦欢灏氭湭 staged 鏃讹紝涔熷彲鑳藉懡涓?diff_only / formatOnly 闄嶅櫔閫昏緫
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
                const workspaceRoot = getEffectiveWorkspaceRoot()?.uri.fsPath;
                diffByFile = await this.fileScanner.getWorkingDiff(workspaceRoot, normalizedFiles);
            }

            return await this.review(normalizedFiles, { diffByFile, traceSession });
        } finally {
            this.runtimeTraceLogger.endRunSession(traceSession);
        }
    }
}
