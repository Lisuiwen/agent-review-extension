/**
 * VSCode 扩展入口文件
 *
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ReviewEngine } from './core/reviewEngine';
import { ConfigManager } from './config/configManager';
import { GitHookManager } from './hooks/gitHookManager';
import { ReviewPanel } from './ui/reviewPanel';
import { StatusBar } from './ui/statusBar';
import { Logger } from './utils/logger';
import { registerRunReviewCommand } from './commands/runReviewCommand';
import { registerRunStagedReviewCommand } from './commands/runStagedReviewCommand';
import { registerReviewCommand } from './commands/reviewCommand';
import { registerShowReportCommand } from './commands/showReportCommand';
import { registerInstallHooksCommand } from './commands/installHooksCommand';
import { registerRefreshCommand } from './commands/refreshCommand';
import { registerAllowIssueIgnoreCommand } from './commands/allowIssueIgnoreCommand';
import { registerFixIssueCommand } from './commands/fixIssueCommand';
import { registerExplainRuntimeLogCommand } from './commands/explainRuntimeLogCommand';
import type { CommandContext } from './commands/commandContext';
import { RuntimeTraceLogger } from './utils/runtimeTraceLogger';
import { resolveRuntimeLogBaseDir } from './utils/runtimeLogPath';

let reviewEngine: ReviewEngine | undefined;
let configManager: ConfigManager | undefined;
let gitHookManager: GitHookManager | undefined;
let reviewPanel: ReviewPanel | undefined;
let statusBar: StatusBar | undefined;

type AutoReviewTrigger = 'save' | 'idle' | 'manual';

type QueuedAutoReviewTask = {
    trigger: AutoReviewTrigger;
    editRevision: number;
    saveRevision: number;
    bypassRateLimit: boolean;
};

type FileAutoReviewState = {
    editRevision: number;
    latestSavedRevision: number;
    latestRequestSeq: number;
    inFlight: boolean;
    queuedTask: QueuedAutoReviewTask | null;
    saveDebounceTimer: ReturnType<typeof setTimeout> | null;
    idleTimer: ReturnType<typeof setTimeout> | null;
    cooldownTimer: ReturnType<typeof setTimeout> | null;
};

type AutoReviewController = vscode.Disposable & {
    reviewCurrentFileNow: () => Promise<void>;
};

/**
 *
 */
const registerAutoReviewOnSave = (deps: CommandContext): AutoReviewController => {
    const { reviewEngine, reviewPanel, statusBar, logger, configManager } = deps;
    const fileStates = new Map<string, FileAutoReviewState>();
    const readyQueue: string[] = [];
    const queuedPaths = new Set<string>();
    const executionTimestamps: number[] = [];
    let activeRuns = 0;
    let isFlushing = false;
    let needsFlush = false;

    const normalizeFilePath = (filePath: string): string => path.normalize(filePath);
    const isRuntimeReady = (): boolean => !!(reviewEngine && reviewPanel && statusBar && configManager);

    /** 若各运行时依赖已就绪则返回组合对象，否则返回 null */
    const getRuntimeDeps = (): {
        reviewEngine: ReviewEngine;
        reviewPanel: ReviewPanel;
        statusBar: StatusBar;
        configManager: ConfigManager;
    } | null =>
        reviewEngine && reviewPanel && statusBar && configManager
            ? { reviewEngine, reviewPanel, statusBar, configManager }
            : null;
    const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
        if (timer) clearTimeout(timer);
        return null;
    };
    const pushReadyPath = (filePath: string): void => {
        if (queuedPaths.has(filePath)) {
            return;
        }
        readyQueue.push(filePath);
        queuedPaths.add(filePath);
    };
    const takeNextReadyPath = (): string | undefined => {
        const next = readyQueue.shift();
        if (next) queuedPaths.delete(next);
        return next;
    };

    const ensureState = (filePath: string): FileAutoReviewState => {
        const normalizedPath = normalizeFilePath(filePath);
        const hit = fileStates.get(normalizedPath);
        if (hit) {
            return hit;
        }
        const created: FileAutoReviewState = {
            editRevision: 0,
            latestSavedRevision: 0,
            latestRequestSeq: 0,
            inFlight: false,
            queuedTask: null,
            saveDebounceTimer: null,
            idleTimer: null,
            cooldownTimer: null,
        };
        fileStates.set(normalizedPath, created);
        return created;
    };

    const pruneExecutionWindow = (): void => {
        const now = Date.now();
        while (executionTimestamps.length > 0 && now - executionTimestamps[0] >= 60_000) {
            executionTimestamps.shift();
        }
    };

    const parseNumber = (value: unknown, fallback: number, min: number, max?: number): number => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return fallback;
        }
        const normalized = Math.floor(value);
        if (normalized < min) {
            return fallback;
        }
        if (typeof max === 'number' && normalized > max) {
            return max;
        }
        return normalized;
    };

    const getRuntimeOptions = () => {
        const config = configManager?.getConfig();
        const ai = config?.ai_review;
        return {
            aiEnabled: ai?.enabled === true,
            runOnSaveEnabled: ai?.run_on_save === true,
            debounceMs: parseNumber(ai?.run_on_save_debounce_ms, 800, 0),
            maxRunsPerMinute: parseNumber(ai?.run_on_save_max_runs_per_minute, 6, 1),
            maxParallelFiles: parseNumber(ai?.auto_review_max_parallel_files, 1, 1, 2),
            enableLocalRebase: ai?.enable_local_rebase !== false,
            largeChangeLineThreshold: parseNumber(ai?.large_change_line_threshold, 40, 1),
            idleRecheckEnabled: ai?.idle_recheck_enabled === true,
            idleRecheckMs: parseNumber(ai?.idle_recheck_ms, 2500, 300),
            manualBypassRateLimit: ai?.review_current_file_now_bypass_rate_limit === true,
        };
    };

    const syncReviewPanelOptions = (): void => {
        if (!reviewPanel) {
            return;
        }
        const options = getRuntimeOptions();
        reviewPanel.configureLocalRebase({
            enabled: options.enableLocalRebase,
            largeChangeLineThreshold: options.largeChangeLineThreshold,
        });
    };

    const updateQueuedStatus = (message: string): void => {
        if (!reviewPanel || !statusBar) {
            return;
        }
        reviewPanel.setStatus('reviewing', message);
        statusBar.updateStatus('reviewing', undefined, message);
    };

    const updateCompletedStatus = (message: string): void => {
        if (!reviewPanel || !statusBar) {
            return;
        }
        const current = reviewPanel.getCurrentResult();
        reviewPanel.setSubStatus(message);
        if (current) {
            statusBar.updateWithResult(current, message);
        } else {
            statusBar.updateStatus('ready', undefined, message);
        }
    };

    const countIssuesForFile = (result: { errors: Array<{ file: string }>; warnings: Array<{ file: string }>; info: Array<{ file: string }> }, targetPath: string): number => {
        const normalizedTarget = normalizeFilePath(targetPath);
        const allIssues = [...result.errors, ...result.warnings, ...result.info];
        return allIssues.filter(issue => normalizeFilePath(issue.file) === normalizedTarget).length;
    };

    const hasErrorDiagnostics = (filePath: string): boolean =>
        vscode.languages
            .getDiagnostics(vscode.Uri.file(filePath))
            .some(item => item.severity === vscode.DiagnosticSeverity.Error);

    const getSaveReviewDoneMessage = (preserveStaleOnEmpty: boolean): string =>
        preserveStaleOnEmpty
            ? 'δУ'
            : '复审完成（已最新保存）';

    const enqueueTask = (filePath: string, task: QueuedAutoReviewTask): void => {
        const normalizedPath = normalizeFilePath(filePath);
        const state = ensureState(normalizedPath);
        state.queuedTask = task; // coalesce：同文件仅保留最后一次任?
        if (!state.inFlight) {
            pushReadyPath(normalizedPath);
        }
        if (task.trigger === 'save') {
            updateQueuedStatus('复审排队中（已合并保存）');
        } else if (task.trigger === 'idle') {
            updateQueuedStatus('编辑暂停后待复审');
        } else {
            updateQueuedStatus('立即复审排队中');
        }
    };

    const scheduleCooldown = (filePath: string, task: QueuedAutoReviewTask, delayMs: number): void => {
        const state = ensureState(filePath);
        state.cooldownTimer = clearTimer(state.cooldownTimer);
        state.queuedTask = task;
        state.cooldownTimer = setTimeout(() => {
            state.cooldownTimer = null;
            if (!state.inFlight && state.queuedTask) {
                pushReadyPath(filePath);
            }
            void flushQueue();
        }, Math.max(0, delayMs));
        updateQueuedStatus('已限频，冷却中');
    };

    const flushQueue = async (): Promise<void> => {
        const runtimeDeps = getRuntimeDeps();
        if (!runtimeDeps) return;
        const { reviewEngine: readyReviewEngine, reviewPanel: readyReviewPanel, statusBar: readyStatusBar } = runtimeDeps;
        if (isFlushing) {
            needsFlush = true;
            return;
        }
        isFlushing = true;
        try {
            do {
                needsFlush = false;
                const options = getRuntimeOptions();
                while (activeRuns < options.maxParallelFiles) {
                    const nextPath = takeNextReadyPath();
                    if (!nextPath) {
                        break;
                    }
                    const state = ensureState(nextPath);
                    if (state.inFlight || !state.queuedTask) {
                        continue;
                    }

                    const task = state.queuedTask;
                    state.queuedTask = null;

                    if (!task.bypassRateLimit) {
                        pruneExecutionWindow();
                        if (executionTimestamps.length >= options.maxRunsPerMinute) {
                            const waitMs = Math.max(100, 60_000 - (Date.now() - executionTimestamps[0]));
                            scheduleCooldown(nextPath, task, waitMs);
                            continue;
                        }
                        executionTimestamps.push(Date.now());
                    }

                    const requestSeq = state.latestRequestSeq + 1;
                    state.latestRequestSeq = requestSeq;
                    state.inFlight = true;
                    activeRuns++;
                    updateQueuedStatus('复审执行中');

                    void (async () => {
                        try {
                            const saveReviewContext = await readyReviewEngine.reviewSavedFileWithPendingDiffContext(nextPath);
                            const result = saveReviewContext.result;
                            const preserveStaleOnEmpty =
                                readyReviewPanel.isFileStale(nextPath)
                                && countIssuesForFile(result, nextPath) === 0
                                && hasErrorDiagnostics(nextPath);
                            const saveReviewDoneMessage = getSaveReviewDoneMessage(preserveStaleOnEmpty);
                            const latestState = ensureState(nextPath);
                            const staleByRequest = requestSeq < latestState.latestRequestSeq;
                            const staleByEdit = task.editRevision < latestState.editRevision;
                            const staleBySave = task.saveRevision < latestState.latestSavedRevision;
                            if (staleByRequest || staleByEdit || staleBySave) {
                                updateCompletedStatus('已丢弃过期结果');
                                return;
                            }
                            readyReviewPanel.applyFileReviewPatch({
                                filePath: nextPath,
                                newResult: result,
                                replaceMode: 'stale_only',
                                status: 'completed',
                                statusMessage: saveReviewDoneMessage,
                                emptyStateHint: '当前保存文件复审未发现问题',
                                preserveStaleOnEmpty,
                                reviewedMode: saveReviewContext.mode,
                                reviewedRanges: saveReviewContext.reviewedRanges,
                            });
                            readyStatusBar.updateWithResult(
                                readyReviewPanel.getCurrentResult() ?? result,
                                saveReviewDoneMessage
                            );
                        } catch (error) {
                            logger.error('自动复审执行失败', error);
                            readyStatusBar.updateStatus('error', undefined, '自动复审失败');
                            readyReviewPanel.setStatus('error', '自动复审失败');
                        } finally {
                            const latestState = ensureState(nextPath);
                            latestState.inFlight = false;
                            activeRuns = Math.max(0, activeRuns - 1);
                            if (latestState.queuedTask) {
                                pushReadyPath(nextPath);
                            }
                            void flushQueue();
                        }
                    })();
                }
            } while (needsFlush);
        } finally {
            isFlushing = false;
        }
    };

    const scheduleSaveReview = (filePath: string): void => {
        const options = getRuntimeOptions();
        const state = ensureState(filePath);
        const snapshotTask: QueuedAutoReviewTask = {
            trigger: 'save',
            editRevision: state.editRevision,
            saveRevision: state.latestSavedRevision,
            bypassRateLimit: false,
        };
        state.saveDebounceTimer = clearTimer(state.saveDebounceTimer);
        if (options.debounceMs <= 0) {
            enqueueTask(filePath, snapshotTask);
            void flushQueue();
            return;
        }
        state.saveDebounceTimer = setTimeout(() => {
            state.saveDebounceTimer = null;
            enqueueTask(filePath, snapshotTask);
            void flushQueue();
        }, options.debounceMs);
    };

    const scheduleIdleReview = (filePath: string): void => {
        const options = getRuntimeOptions();
        if (!options.idleRecheckEnabled || !reviewPanel) {
            return;
        }
        const state = ensureState(filePath);
        state.idleTimer = clearTimer(state.idleTimer);
        state.idleTimer = setTimeout(() => {
            state.idleTimer = null;
            const editor = vscode.window.visibleTextEditors.find(
                item => normalizeFilePath(item.document.uri.fsPath) === filePath
            );
            if (!editor || editor.document.isDirty) {
                return;
            }
            if (!reviewPanel.isFileStale(filePath)) {
                return;
            }
            enqueueTask(filePath, {
                trigger: 'idle',
                editRevision: state.editRevision,
                saveRevision: state.latestSavedRevision,
                bypassRateLimit: false,
            });
            void flushQueue();
        }, options.idleRecheckMs);
    };

    const reviewCurrentFileNow = async (): Promise<void> => {
        if (!isRuntimeReady()) {
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            vscode.window.showInformationMessage('请先打开一个本地文件后再执行“立即复审当前文件”');
            return;
        }
        if (editor.document.isDirty) {
            vscode.window.showWarningMessage('当前文件尚未保存，请先保存后再立即复审');
            return;
        }
        const filePath = normalizeFilePath(editor.document.uri.fsPath);
        const options = getRuntimeOptions();
        if (!options.aiEnabled) {
            vscode.window.showInformationMessage('AI 审查未启用，无法执行立即复审');
            return;
        }
        const state = ensureState(filePath);
        state.latestSavedRevision = Math.max(state.latestSavedRevision, state.editRevision);
        enqueueTask(filePath, {
            trigger: 'manual',
            editRevision: state.editRevision,
            saveRevision: state.latestSavedRevision,
            bypassRateLimit: options.manualBypassRateLimit,
        });
        void flushQueue();
    };

    const onDidChangeTextDocument = (vscode.workspace as unknown as {
        onDidChangeTextDocument?: (
            listener: (event: vscode.TextDocumentChangeEvent) => void
        ) => vscode.Disposable;
    }).onDidChangeTextDocument;
    const onDidSaveTextDocument = (vscode.workspace as unknown as {
        onDidSaveTextDocument?: (
            listener: (event: vscode.TextDocument) => void
        ) => vscode.Disposable;
    }).onDidSaveTextDocument;

    const onDidChangeDisposable = onDidChangeTextDocument
        ? onDidChangeTextDocument((event) => {
            if (event.document.uri.scheme !== 'file') {
                return;
            }
            const filePath = normalizeFilePath(event.document.uri.fsPath);
            const state = ensureState(filePath);
            state.editRevision += 1;
            syncReviewPanelOptions();
            const options = getRuntimeOptions();
            if (!options.idleRecheckEnabled) {
                return;
            }
            const changedLineCount = event.contentChanges.reduce((sum, change) => {
                const removedLineCount = Math.max(0, change.range.end.line - change.range.start.line);
                const addedLineCount = (change.text.match(/\n/g) ?? []).length;
                return sum + Math.max(removedLineCount, addedLineCount) + 1;
            }, 0);
            if (changedLineCount > options.largeChangeLineThreshold) {
                return;
            }
            scheduleIdleReview(filePath);
        })
        : { dispose: () => {} };

    const onDidSaveDisposable = onDidSaveTextDocument
        ? onDidSaveTextDocument((document) => {
            if (document.uri.scheme !== 'file') {
                return;
            }
            if (!isRuntimeReady()) {
                return;
            }
            const options = getRuntimeOptions();
            if (!options.aiEnabled || !options.runOnSaveEnabled) {
                return;
            }
            const filePath = normalizeFilePath(document.uri.fsPath);
            const state = ensureState(filePath);
            state.latestSavedRevision = state.editRevision;
            scheduleSaveReview(filePath);
        })
        : { dispose: () => {} };

    syncReviewPanelOptions();

    return {
        reviewCurrentFileNow,
        dispose: () => {
            onDidChangeDisposable.dispose();
            onDidSaveDisposable.dispose();
            for (const state of fileStates.values()) {
                state.saveDebounceTimer = clearTimer(state.saveDebounceTimer);
                state.idleTimer = clearTimer(state.idleTimer);
                state.cooldownTimer = clearTimer(state.cooldownTimer);
            }
            fileStates.clear();
            queuedPaths.clear();
            readyQueue.splice(0, readyQueue.length);
            executionTimestamps.splice(0, executionTimestamps.length);
        },
    };
};

const getGitRoot = (): string | null => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return null;
    let currentPath = workspaceRoot;
    while (currentPath !== path.dirname(currentPath)) {
        const gitPath = path.join(currentPath, '.git');
        if (fs.existsSync(gitPath)) return currentPath;
        currentPath = path.dirname(currentPath);
    }
    return null;
};

export const activate = async (context: vscode.ExtensionContext) => {
    const logger = new Logger('AgentReview');
    logger.info('AgentReview插件正在?..');

    try {
        configManager = new ConfigManager();
        await configManager.initialize(context);
        const runtimeTraceLogger = RuntimeTraceLogger.getInstance();
        const runtimeBaseDir = resolveRuntimeLogBaseDir(context, configManager.getConfig().runtime_log);
        await runtimeTraceLogger.initialize({
            baseDir: runtimeBaseDir,
            config: configManager.getConfig().runtime_log,
        });
        Logger.setInfoOutputEnabled(runtimeTraceLogger.shouldOutputInfoToChannel());

        reviewEngine = new ReviewEngine(configManager);
        await reviewEngine.initialize();

        gitHookManager = new GitHookManager(context);
        reviewPanel = new ReviewPanel(context);
        statusBar = new StatusBar();
        reviewPanel.configureLocalRebase({
            enabled: configManager.getConfig().ai_review?.enable_local_rebase !== false,
            largeChangeLineThreshold: configManager.getConfig().ai_review?.large_change_line_threshold ?? 40,
        });

        const config = configManager.getConfig();
        if (config.git_hooks?.auto_install && config.git_hooks?.pre_commit_enabled) {
            const isInstalled = await gitHookManager.isHookInstalled();
            if (!isInstalled) {
                logger.info('鑷姩瀹夎 pre-commit hook');
                await gitHookManager.installPreCommitHook();
            }
        }

        const commandDeps: CommandContext = {
            reviewEngine,
            configManager,
            gitHookManager,
            reviewPanel,
            statusBar,
            logger,
            getGitRoot,
        };

        const autoReviewController = registerAutoReviewOnSave(commandDeps);
        const reviewCurrentFileNowDisposable = vscode.commands.registerCommand(
            'agentreview.reviewCurrentFileNow',
            async () => {
                await autoReviewController.reviewCurrentFileNow();
            }
        );

        context.subscriptions.push(
            registerRunReviewCommand(commandDeps),
            registerRunStagedReviewCommand(commandDeps),
            registerReviewCommand(),
            registerShowReportCommand(commandDeps),
            registerInstallHooksCommand(commandDeps),
            registerRefreshCommand(),
            registerAllowIssueIgnoreCommand(commandDeps),
            registerFixIssueCommand(commandDeps),
            registerExplainRuntimeLogCommand(commandDeps, context),
            autoReviewController,
            reviewCurrentFileNowDisposable,
            reviewPanel,
            statusBar,
            configManager
        );

        logger.info('AgentReview插件激活成功');
    } catch (error) {
        logger.error('插件激活失败', error);
        vscode.window.showErrorMessage('AgentReview插件激活失败');
    }
};

export const deactivate = async (): Promise<void> => {
    reviewPanel?.dispose();
    statusBar?.dispose();
    configManager?.dispose();
    await RuntimeTraceLogger.getInstance().flushAndCloseAll();
    Logger.disposeSharedOutputChannel();
    reviewEngine = undefined;
    configManager = undefined;
    gitHookManager = undefined;
    reviewPanel = undefined;
    statusBar = undefined;
};

