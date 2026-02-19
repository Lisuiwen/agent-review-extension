/**
 * VSCode 扩展入口文件
 *
 * 职责：插件激活与停用、初始化各组件、注册命令（具体逻辑在 src/commands/）。
 * VSCode 在插件首次加载或执行相关命令时调用 activate。
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

/**
 * 注册“保存即审查”监听器。
 *
 * 说明：
 * - 仅在 ai_review.run_on_save=true 且 ai_review.enabled=true 时触发
 * - 采用串行队列，避免频繁保存导致并发审查互相覆盖面板状态
 */
const registerAutoReviewOnSave = (deps: CommandContext): vscode.Disposable => {
    let queue = Promise.resolve();
    return vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme !== 'file') {
            return;
        }
        const { reviewEngine, reviewPanel, statusBar, logger, configManager } = deps;
        if (!reviewEngine || !reviewPanel || !statusBar || !configManager) {
            return;
        }
        const config = configManager.getConfig();
        if (!config.ai_review?.enabled || config.ai_review.run_on_save !== true) {
            return;
        }
        queue = queue.then(async () => {
            try {
                statusBar.updateStatus('reviewing');
                reviewPanel.setStatus('reviewing');
                const result = await reviewEngine.reviewFilesWithWorkingDiff([document.uri.fsPath]);
                reviewPanel.showReviewResult(result, 'completed');
                statusBar.updateWithResult(result);
            } catch (error) {
                logger.error('保存触发的自动审查失败', error);
                statusBar.updateStatus('error');
                reviewPanel.setStatus('error');
            }
        });
    });
};

/** 从工作区向上查找 .git，用于安装 Hooks 等 */
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
    logger.info('AgentReview插件正在激活...');

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

        const config = configManager.getConfig();
        if (config.git_hooks?.auto_install && config.git_hooks?.pre_commit_enabled) {
            const isInstalled = await gitHookManager.isHookInstalled();
            if (!isInstalled) {
                logger.info('自动安装 pre-commit hook');
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

        context.subscriptions.push(
            registerRunReviewCommand(commandDeps),
            registerReviewCommand(),
            registerShowReportCommand(commandDeps),
            registerInstallHooksCommand(commandDeps),
            registerRefreshCommand(),
            registerAllowIssueIgnoreCommand(commandDeps),
            registerFixIssueCommand(commandDeps),
            registerExplainRuntimeLogCommand(commandDeps, context),
            registerAutoReviewOnSave(commandDeps),
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
