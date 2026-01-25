/**
 * Git Hook 管理器
 * 
 * 这个文件负责安装和管理 Git pre-commit hook
 * 
 * 主要功能：
 * 1. 自动安装 pre-commit hook 到 .git/hooks 目录
 * 2. 生成跨平台的 hook 脚本（支持 Windows 和 Unix）
 * 3. 检查 hook 是否已安装
 * 4. 卸载 hook（如果需要）
 * 
 * Git Hook 工作原理：
 * - Git 在执行 commit 前会自动执行 .git/hooks/pre-commit 脚本
 * - 如果脚本退出码为 0，提交继续
 * - 如果脚本退出码非 0，提交被阻止
 * 
 * Hook 脚本内容：
 * - 调用扩展的 hookRunner.js 脚本
 * - hookRunner 会执行代码审查
 * - 如果审查失败，返回非 0 退出码阻止提交
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Git Hook 管理器类
 * 
 * 使用方式：
 * ```typescript
 * const hookManager = new GitHookManager(context);
 * await hookManager.installPreCommitHook();
 * ```
 */
export class GitHookManager {
    private context: vscode.ExtensionContext;
    private logger: Logger;
    private workspaceRoot: string | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.logger = new Logger('GitHookManager');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        this.workspaceRoot = workspaceFolder?.uri.fsPath;
    }

    /**
     * 安装 pre-commit hook
     * 
     * 这个方法会在 .git/hooks/pre-commit 位置创建一个脚本文件
     * 当用户执行 git commit 时，Git 会自动执行这个脚本
     * 
     * 安装流程：
     * 1. 查找 .git/hooks 目录
     * 2. 检查是否已存在 hook（如果存在且不是我们的，会备份）
     * 3. 生成 hook 脚本内容
     * 4. 写入脚本文件并设置执行权限
     * 
     * @returns 安装是否成功
     */
    async installPreCommitHook(): Promise<boolean> {
        this.logger.info('安装pre-commit hook');
        
        // 步骤1：查找 .git/hooks 目录
        const hookPath = this.getGitHookPath();
        if (!hookPath) {
            this.logger.error('无法找到 .git/hooks 目录');
            return false;
        }

        const preCommitHookPath = path.join(hookPath, 'pre-commit');
        
        // 步骤2：检查是否已存在 hook
        if (fs.existsSync(preCommitHookPath)) {
            // 读取现有 hook 内容
            const existingContent = await fs.promises.readFile(preCommitHookPath, 'utf-8');
            // 检查是否已经是我们的 hook（通过检查内容中是否包含 'agentreview'）
            if (existingContent.includes('agentreview') || existingContent.includes('AgentReview')) {
                this.logger.info('pre-commit hook 已存在且可能是 AgentReview 的 hook');
                return true;  // 已安装，无需重复安装
            } else {
                // 如果存在其他 hook，先备份（避免覆盖用户的自定义 hook）
                const backupPath = `${preCommitHookPath}.backup.${Date.now()}`;
                await fs.promises.copyFile(preCommitHookPath, backupPath);
                this.logger.info(`已备份现有 hook 到: ${backupPath}`);
            }
        }

        try {
            // 步骤3：生成 hook 脚本内容
            // generateHookScript 会根据操作系统生成不同的脚本（Windows 批处理或 Unix shell）
            const hookScript = this.generateHookScript();
            
            // 步骤4：写入 hook 文件
            // mode: 0o755 设置文件权限为可执行（rwxr-xr-x）
            await fs.promises.writeFile(preCommitHookPath, hookScript, { mode: 0o755 });
            
            this.logger.info('pre-commit hook 安装成功');
            return true;
        } catch (error) {
            this.logger.error('安装 pre-commit hook 失败', error);
            return false;
        }
    }

    async uninstallPreCommitHook(): Promise<boolean> {
        this.logger.info('卸载pre-commit hook');
        
        const hookPath = this.getGitHookPath();
        if (!hookPath) {
            return false;
        }

        const preCommitHookPath = path.join(hookPath, 'pre-commit');
        
        if (!fs.existsSync(preCommitHookPath)) {
            this.logger.info('pre-commit hook 不存在');
            return true;
        }

        try {
            // 检查是否是我们的 hook
            const content = await fs.promises.readFile(preCommitHookPath, 'utf-8');
            if (content.includes('agentreview') || content.includes('AgentReview')) {
                await fs.promises.unlink(preCommitHookPath);
                this.logger.info('pre-commit hook 卸载成功');
                return true;
            } else {
                this.logger.warn('pre-commit hook 不是 AgentReview 的，未卸载');
                return false;
            }
        } catch (error) {
            this.logger.error('卸载 pre-commit hook 失败', error);
            return false;
        }
    }

    async isHookInstalled(): Promise<boolean> {
        const hookPath = this.getGitHookPath();
        if (!hookPath) {
            return false;
        }

        const preCommitHookPath = path.join(hookPath, 'pre-commit');
        
        if (!fs.existsSync(preCommitHookPath)) {
            return false;
        }

        try {
            const content = await fs.promises.readFile(preCommitHookPath, 'utf-8');
            return content.includes('agentreview') || content.includes('AgentReview');
        } catch {
            return false;
        }
    }

    private getGitHookPath(): string | null {
        if (!this.workspaceRoot) {
            return null;
        }

        // 查找 .git 目录
        let currentPath = this.workspaceRoot;
        while (currentPath !== path.dirname(currentPath)) {
            const gitPath = path.join(currentPath, '.git');
            if (fs.existsSync(gitPath)) {
                const hooksPath = path.join(gitPath, 'hooks');
                if (fs.existsSync(hooksPath)) {
                    return hooksPath;
                }
                break;
            }
            currentPath = path.dirname(currentPath);
        }

        return null;
    }

    /**
     * 生成 hook 脚本内容
     * 
     * 这个方法会根据操作系统生成不同的脚本：
     * - Windows: 生成批处理脚本（.bat 格式，但 Git 会识别为 pre-commit）
     * - Unix/Linux/Mac: 生成 shell 脚本
     * 
     * 脚本功能：
     * 1. 设置工作区根目录环境变量
     * 2. 调用 hookRunner.js 执行代码审查
     * 3. 根据审查结果返回退出码（0=通过，1=失败）
     * 
     * @returns 生成的脚本内容（字符串）
     */
    private generateHookScript(): string {
        if (!this.workspaceRoot) {
            throw new Error('未找到工作区根目录');
        }

        // 获取扩展的安装路径
        // context.extensionPath 是 VSCode 提供的 API，返回扩展的安装目录
        const extensionPath = this.context.extensionPath;
        // hookRunner.js 是编译后的独立脚本，可以在 Git hook 中直接运行
        const hookRunnerPath = path.join(extensionPath, 'out', 'hooks', 'hookRunner.js');
        
        // 检测操作系统
        // process.platform 是 Node.js 的全局变量，'win32' 表示 Windows
        const isWindows = process.platform === 'win32';

        // 统一准备脚本中用到的路径
        // 注意：Windows 批处理更偏好反斜杠路径，避免不必要的路径转换
        const workspaceRootPath = isWindows ? path.normalize(this.workspaceRoot) : this.workspaceRoot;
        const hookRunnerPathNormalized = isWindows ? path.normalize(hookRunnerPath) : hookRunnerPath;
        const nodeExecPath = isWindows ? path.normalize(process.execPath) : process.execPath;
        
        if (isWindows) {
            // Windows 批处理脚本
            // Git 在 Windows 上也能识别和执行这种格式的 pre-commit 文件
            return `@echo off
REM AgentReview pre-commit hook
REM 设置工作区根目录环境变量，hookRunner 会读取这个变量
set "WORKSPACE_ROOT=${workspaceRootPath}"
REM 执行 hookRunner.js 脚本
REM 使用 VSCode 扩展运行时的 Node.js，避免 PATH 不可用
"${nodeExecPath}" "${hookRunnerPathNormalized}"
REM 检查退出码，如果非 0 则阻止提交
if errorlevel 1 (
    exit /b 1
)
exit /b 0
`;
        } else {
            // Unix/Linux/Mac shell 脚本
            // #!/bin/sh 是 shebang，告诉系统使用 sh 解释器执行
            return `#!/bin/sh
# AgentReview pre-commit hook
# 设置工作区根目录环境变量
export WORKSPACE_ROOT="${workspaceRootPath}"
# 使用 Node.js 执行 hookRunner.js
# process.execPath 是 Node.js 可执行文件的路径
"${nodeExecPath}" "${hookRunnerPathNormalized}"
# 返回退出码（$? 是上一个命令的退出码）
exit $?
`;
        }
    }
}
