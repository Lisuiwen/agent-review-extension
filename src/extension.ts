/**
 * VSCode 扩展入口文件
 * 
 * 这是整个插件的核心入口点，负责：
 * 1. 插件激活时的初始化工作
 * 2. 注册所有命令（commands）
 * 3. 管理各个组件的生命周期
 * 4. 处理插件的激活和停用
 * 
 * VSCode 会在以下情况调用 activate 函数：
 * - 插件首次加载时
 * - 用户执行插件相关命令时
 * - 满足 activationEvents 条件时（在 package.json 中定义）
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ReviewEngine, ReviewIssue } from './core/reviewEngine';
import { ConfigManager } from './config/configManager';
import { GitHookManager } from './hooks/gitHookManager';
import { ReviewPanel, ReviewTreeItem } from './ui/reviewPanel';
import { StatusBar } from './ui/statusBar';
import { Logger } from './utils/logger';

// 全局变量：存储各个组件的实例
// 这些变量在插件激活时初始化，在停用时清理
let reviewEngine: ReviewEngine | undefined;      // 审查引擎：负责执行代码审查
let configManager: ConfigManager | undefined;   // 配置管理器：负责读取和管理配置文件
let gitHookManager: GitHookManager | undefined;  // Git Hook管理器：负责安装和管理 Git hooks
let reviewPanel: ReviewPanel | undefined;        // 审查面板：负责在侧边栏显示审查结果
let statusBar: StatusBar | undefined;            // 状态栏：负责在底部状态栏显示审查状态

/**
 * 插件激活函数
 * 
 * 这是 VSCode 扩展的入口函数，当插件被激活时会被调用
 * @param context - VSCode 扩展上下文，包含插件的路径、订阅等信息
 * 
 * 激活流程：
 * 1. 初始化配置管理器（读取 .agentreview.yaml）
 * 2. 初始化审查引擎（用于执行代码审查）
 * 3. 初始化 Git Hook 管理器（用于安装 pre-commit hook）
 * 4. 初始化 GUI 组件（TreeView 和状态栏）
 * 5. 注册所有命令（用户可以通过命令面板或按钮触发）
 */
export const activate = async (context: vscode.ExtensionContext) => {
    const logger = new Logger('AgentReview');
    logger.info('AgentReview插件正在激活...');

    try {
        // 步骤1：初始化配置管理器
        // ConfigManager 负责读取项目根目录下的 .agentreview.yaml 配置文件
        // 传入 context 以便单工作区时从扩展目录回退加载 .env
        configManager = new ConfigManager();
        await configManager.initialize(context);

        // 步骤2：初始化审查引擎
        // ReviewEngine 是核心组件，负责协调规则引擎和文件扫描器
        // 它接收配置管理器，以便在审查时读取配置
        reviewEngine = new ReviewEngine(configManager);
        // 初始化审查引擎（包括AI审查器）
        await reviewEngine.initialize();

        // 步骤3：初始化Git Hooks管理器
        // GitHookManager 负责在 .git/hooks 目录下安装 pre-commit 脚本
        // 需要传入 context 以获取扩展的安装路径
        gitHookManager = new GitHookManager(context);

        // 步骤4：初始化GUI组件
        // ReviewPanel: 在 VSCode 侧边栏创建一个 TreeView，用于显示审查结果
        // StatusBar: 在 VSCode 底部状态栏显示审查状态和问题计数
        reviewPanel = new ReviewPanel(context);
        statusBar = new StatusBar();

        // 步骤5：如果配置了自动安装 hook，则尝试安装
        // 检查配置文件中是否启用了自动安装和 pre-commit hook
        const config = configManager.getConfig();
        if (config.git_hooks?.auto_install && config.git_hooks?.pre_commit_enabled) {
            const isInstalled = await gitHookManager.isHookInstalled();
            if (!isInstalled) {
                logger.info('自动安装 pre-commit hook');
                await gitHookManager.installPreCommitHook();
            }
        }

        // ========== 注册命令 ==========
        // VSCode 命令是用户与插件交互的主要方式
        // 用户可以通过命令面板（Ctrl+Shift+P）或按钮触发这些命令

        /**
         * 工具函数：从 TreeItem 或命令参数中提取 ReviewIssue
         * 
         * @param item - TreeView 传入的节点
         * @returns ReviewIssue 或 null
         */
        const getIssueFromItem = (item?: ReviewTreeItem | ReviewIssue): ReviewIssue | null => {
            if (!item) {
                return null;
            }
            if ('issue' in item && item.issue) {
                return item.issue;
            }
            if ('file' in item && 'line' in item && 'column' in item && 'message' in item) {
                return item as ReviewIssue;
            }
            return null;
        };

        /**
         * 工具函数：查找 Git 根目录
         * 
         * 从工作区目录向上查找 .git 目录，用于生成一次性放行标记
         */
        const getGitRoot = (): string | null => {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                return null;
            }
            let currentPath = workspaceRoot;
            while (currentPath !== path.dirname(currentPath)) {
                const gitPath = path.join(currentPath, '.git');
                if (fs.existsSync(gitPath)) {
                    return currentPath;
                }
                currentPath = path.dirname(currentPath);
            }
            return null;
        };

        /**
         * 创建“一次性放行”标记文件
         * 
         * HookRunner 检测到该标记后会跳过一次审查并删除标记
         */
        const createAllowCommitToken = async (): Promise<void> => {
            if (!configManager) {
                vscode.window.showErrorMessage('配置管理器未初始化');
                return;
            }
            const config = configManager.getConfig();
            if (config.git_hooks?.allow_commit_once === false) {
                vscode.window.showInformationMessage('当前配置已禁用“一次性放行”');
                return;
            }
            const gitRoot = getGitRoot();
            if (!gitRoot) {
                vscode.window.showErrorMessage('未找到 Git 根目录，无法放行提交');
                return;
            }
            const tokenDir = path.join(gitRoot, '.git', 'agentreview');
            const tokenPath = path.join(tokenDir, 'allow-commit');
            try {
                await fs.promises.mkdir(tokenDir, { recursive: true });
                const tokenContent = `allowed-at=${new Date().toISOString()}\n`;
                await fs.promises.writeFile(tokenPath, tokenContent, 'utf-8');
                vscode.window.showInformationMessage('已放行下一次提交（一次性）');
            } catch (error) {
                logger.error('创建放行标记失败', error);
                vscode.window.showErrorMessage('放行提交失败，请检查权限或路径');
            }
        };

        // 命令1：agentreview.run - 手动触发代码审查
        // 这是主要的审查命令，会扫描所有 staged 文件并执行规则检查
        const runCommand = vscode.commands.registerCommand('agentreview.run', async () => {
            logger.info('执行代码审查命令');
            if (!reviewEngine || !reviewPanel || !statusBar) {
                logger.error('组件未初始化', { reviewEngine: !!reviewEngine, reviewPanel: !!reviewPanel, statusBar: !!statusBar });
                vscode.window.showErrorMessage('组件未初始化');
                return;
            }
            
            try {
                logger.info('开始执行审查流程');
                // 更新状态为审查中
                statusBar.updateStatus('reviewing');
                reviewPanel.setStatus('reviewing');
                reviewPanel.reveal();

                logger.info('调用 reviewEngine.reviewStagedFiles()');
                // 执行审查
                const result = await reviewEngine.reviewStagedFiles();
                logger.info(`审查完成，结果: passed=${result.passed}, errors=${result.errors.length}, warnings=${result.warnings.length}, info=${result.info.length}`);
                
                // 更新GUI
                reviewPanel.showReviewResult(result, 'completed');
                statusBar.updateWithResult(result);
                
                // 显示通知
                if (result.passed) {
                    if (result.warnings.length > 0 || result.info.length > 0) {
                        vscode.window.showInformationMessage(
                            `✓ 代码审查通过 (${result.warnings.length}个警告, ${result.info.length}个信息)`
                        );
                    } else {
                        vscode.window.showInformationMessage('✓ 代码审查通过');
                    }
                } else {
                    const errorCount = result.errors.length;
                    const warningCount = result.warnings.length;
                    vscode.window.showWarningMessage(
                        `代码审查发现问题: ${errorCount}个错误, ${warningCount}个警告`
                    );
                }
            } catch (error) {
                logger.error('审查过程出错', error);
                statusBar.updateStatus('error');
                reviewPanel.setStatus('error');
                vscode.window.showErrorMessage('代码审查失败，请查看输出日志');
            }
        });

        // 命令2：agentreview.review - 保持向后兼容的别名
        // 这个命令直接调用 agentreview.run，用于保持与旧版本的兼容性
        const reviewCommand = vscode.commands.registerCommand('agentreview.review', async () => {
            await vscode.commands.executeCommand('agentreview.run');
        });

        // 命令3：agentreview.showReport - 显示审查报告
        // 这个命令会打开侧边栏的审查结果面板，方便用户查看之前的审查结果
        const showReportCommand = vscode.commands.registerCommand('agentreview.showReport', async () => {
            logger.info('显示审查报告命令');
            // 显示输出通道，确保用户能看到日志（仅在开发调试时有用）
            // 注意：在生产环境中，用户可以通过"视图 -> 输出 -> AgentReview"手动查看日志
            if (reviewPanel) {
                reviewPanel.reveal();
                logger.info('审查面板已显示');
            } else {
                logger.warn('审查面板未初始化');
                vscode.window.showInformationMessage('审查面板未初始化');
            }
        });

        // 命令4：agentreview.installHooks - 手动安装 Git Hooks
        // 用户可以手动触发这个命令来安装 pre-commit hook
        // 如果自动安装失败，可以使用这个命令重试
        const installHooksCommand = vscode.commands.registerCommand('agentreview.installHooks', async () => {
            logger.info('安装Git Hooks命令');
            if (!gitHookManager) {
                vscode.window.showErrorMessage('Git Hook管理器未初始化');
                return;
            }
            
            try {
                const success = await gitHookManager.installPreCommitHook();
                if (success) {
                    vscode.window.showInformationMessage('✓ Git Hooks安装成功');
                } else {
                    vscode.window.showWarningMessage('Git Hooks安装失败或已存在');
                }
            } catch (error) {
                logger.error('安装Git Hooks失败', error);
                vscode.window.showErrorMessage('安装Git Hooks失败');
            }
        });

        // 命令5：agentreview.refresh - 刷新审查结果
        // 这个命令通常绑定到 TreeView 标题栏的刷新按钮
        // 点击刷新按钮会重新执行审查
        const refreshCommand = vscode.commands.registerCommand('agentreview.refresh', async () => {
            await vscode.commands.executeCommand('agentreview.run');
        });

        // 命令6：agentreview.allowCommitOnce - 一次性放行提交
        // 创建放行标记文件，供 pre-commit hook 检测
        const allowCommitOnceCommand = vscode.commands.registerCommand('agentreview.allowCommitOnce', async () => {
            await createAllowCommitToken();
        });

        // 命令7：agentreview.fixIssue - 修复当前问题（占位，后续可接入 AI 或 CodeLens）
        const fixIssueCommand = vscode.commands.registerCommand('agentreview.fixIssue', async () => {
            const issue = reviewPanel?.getActiveIssueForActions();
            if (!issue) {
                vscode.window.showInformationMessage('请先在审查结果中选中一个问题，或悬停到问题行上再点击修复');
                return;
            }
            vscode.window.showInformationMessage('修复功能占位，后续可接入 AI 或 CodeLens');
        });

        // 将所有命令和组件注册到 context.subscriptions
        // 这样当插件停用时，VSCode 会自动清理这些资源
        // 这是 VSCode 扩展开发的最佳实践，可以防止内存泄漏
        context.subscriptions.push(
            runCommand,
            reviewCommand,
            showReportCommand,
            installHooksCommand,
            refreshCommand,
            allowCommitOnceCommand,
            fixIssueCommand,
            reviewPanel,
            statusBar,
            configManager  // 注册配置管理器，确保文件监听器在插件停用时被清理
        );

        logger.info('AgentReview插件激活成功');
    } catch (error) {
        logger.error('插件激活失败', error);
        vscode.window.showErrorMessage('AgentReview插件激活失败');
    }
};

/**
 * 插件停用函数
 * 
 * 当插件被停用或卸载时，VSCode 会调用这个函数
 * 这里需要清理所有资源，防止内存泄漏
 * 
 * 注意：虽然 context.subscriptions 会自动清理已注册的资源，
 * 但这里我们显式地清理全局变量，确保完全释放内存
 */
export const deactivate = () => {
    // 清理 GUI 组件
    reviewPanel?.dispose();
    statusBar?.dispose();
    
    // 清理配置管理器（包括文件监听器）
    // 注意：由于 configManager 已注册到 context.subscriptions，
    // VSCode 会自动调用 dispose，但这里显式调用确保清理
    configManager?.dispose();

    // 清理共享日志通道，避免输出通道残留
    Logger.disposeSharedOutputChannel();
    
    // 清理全局变量
    reviewEngine = undefined;
    configManager = undefined;
    gitHookManager = undefined;
    reviewPanel = undefined;
    statusBar = undefined;
};
