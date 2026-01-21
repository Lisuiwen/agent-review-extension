import * as vscode from 'vscode';
import { ReviewEngine } from './core/reviewEngine';
import { ConfigManager } from './config/configManager';
import { GitHookManager } from './hooks/gitHookManager';
import { Logger } from './utils/logger';

let reviewEngine: ReviewEngine | undefined;
let configManager: ConfigManager | undefined;
let gitHookManager: GitHookManager | undefined;

export const activate = async (context: vscode.ExtensionContext) => {
    const logger = new Logger('AgentReview');
    logger.info('AgentReview插件正在激活...');

    try {
        // 初始化配置管理器
        configManager = new ConfigManager();
        await configManager.initialize();

        // 初始化审查引擎
        reviewEngine = new ReviewEngine(configManager);

        // 初始化Git Hooks管理器
        gitHookManager = new GitHookManager(context);

        // 注册命令
        const reviewCommand = vscode.commands.registerCommand('agentreview.review', async () => {
            // TODO: 实现审查命令
        });

        const showReportCommand = vscode.commands.registerCommand('agentreview.showReport', async () => {
            // TODO: 实现显示报告命令
        });

        const installHooksCommand = vscode.commands.registerCommand('agentreview.installHooks', async () => {
            // TODO: 实现安装hooks命令
        });

        context.subscriptions.push(reviewCommand, showReportCommand, installHooksCommand);

        // TODO: 注册Source Control拦截
        // TODO: 注册其他事件监听器

        logger.info('AgentReview插件激活成功');
    } catch (error) {
        logger.error('插件激活失败', error);
        vscode.window.showErrorMessage('AgentReview插件激活失败');
    }
};

export const deactivate = () => {
    // TODO: 清理资源
    reviewEngine = undefined;
    configManager = undefined;
    gitHookManager = undefined;
};
