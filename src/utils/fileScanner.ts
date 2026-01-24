/**
 * 文件扫描器
 * 
 * 这个文件负责与 Git 交互，获取需要审查的文件列表
 * 
 * 主要功能：
 * 1. 获取 Git staged（已暂存）的文件列表
 * 2. 读取文件内容
 * 3. 检查文件是否在排除列表中
 * 
 * 工作原理：
 * - 使用 Git 命令 'git diff --cached --name-only' 获取 staged 文件
 * - 这个命令会返回所有已添加到暂存区的文件路径
 * 
 * 使用场景：
 * - 用户执行审查命令时
 * - Git pre-commit hook 执行时
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';  // Node.js 的进程执行模块
import { promisify } from 'util';      // 将回调函数转换为 Promise
import { Logger } from './logger';

// 将 exec 转换为 Promise 形式，方便使用 async/await
const execAsync = promisify(exec);

/**
 * 文件扫描器类
 * 
 * 使用方式：
 * ```typescript
 * const scanner = new FileScanner();
 * const stagedFiles = await scanner.getStagedFiles();
 * ```
 */
export class FileScanner {
    private logger: Logger;
    private workspaceRoot: string | undefined;

    constructor() {
        this.logger = new Logger('FileScanner');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        this.workspaceRoot = workspaceFolder?.uri.fsPath;
    }

    /**
     * 获取 Git staged（已暂存）的文件列表
     * 
     * 这个方法使用 Git 命令获取所有已添加到暂存区的文件
     * 
     * Git 命令说明：
     * - git diff --cached: 显示已暂存（staged）的更改
     * - --name-only: 只显示文件名，不显示具体更改内容
     * 
     * @returns 文件路径数组（绝对路径）
     * 
     * 示例：
     * ```typescript
     * const files = await scanner.getStagedFiles();
     * // 返回: ['/path/to/file1.ts', '/path/to/file2.ts']
     * ```
     */
    async getStagedFiles(): Promise<string[]> {
        this.logger.info('获取staged文件');
        
        // 检查是否有工作区
        if (!this.workspaceRoot) {
            this.logger.warn('未找到工作区，无法获取staged文件');
            return [];
        }

        try {
            // 执行 Git 命令获取 staged 文件列表
            // execAsync 会在指定的工作目录（cwd）中执行命令
            const { stdout, stderr } = await execAsync('git diff --cached --name-only', {
                cwd: this.workspaceRoot,  // 在工作区根目录执行命令
                encoding: 'utf-8',        // 指定输出编码为 UTF-8
            });

            // 如果只有 stderr 没有 stdout，可能是没有 staged 文件或不是 git 仓库
            if (stderr && !stdout) {
                this.logger.debug(`Git命令输出: ${stderr}`);
                return [];
            }

            // 解析 Git 命令的输出
            // Git 命令返回的是每行一个文件路径的文本
            const files = stdout
                .split('\n')                    // 按行分割
                .map(line => line.trim())        // 去除每行的首尾空格
                .filter(line => line.length > 0) // 过滤空行
                .map(file => 
                    // 将相对路径转换为绝对路径
                    // path.isAbsolute 检查路径是否是绝对路径
                    path.isAbsolute(file) 
                        ? file 
                        : path.join(this.workspaceRoot!, file)
                );

            if (files.length > 0) {
                this.logger.info(`找到 ${files.length} 个staged文件`);
            }
            return files;
        } catch (error: any) {
            // 错误处理
            // Git 命令可能因为以下原因失败：
            // 1. 不是 Git 仓库（exit code 1）
            // 2. 没有 staged 文件
            // 3. Git 未安装
            if (error.code === 1 || error.message?.includes('not a git repository')) {
                this.logger.debug('未找到git仓库或没有staged文件');
                return [];
            }
            this.logger.error('获取staged文件失败', error);
            return [];
        }
    }

    async getChangedFiles(): Promise<string[]> {
        // TODO: 获取变更文件列表
        this.logger.info('获取变更文件');
        return [];
    }

    async readFile(filePath: string): Promise<string> {
        // TODO: 读取文件内容
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return content;
        } catch (error) {
            this.logger.error(`读取文件失败: ${filePath}`, error);
            throw error;
        }
    }

    /**
     * 检查文件是否应该被排除
     * 
     * 支持简单的glob模式匹配：
     * - *.log 匹配所有.log文件
     * - test-*.ts 匹配test-开头的.ts文件
     * - 支持通配符模式匹配目录和文件
     * 
     * @param filePath - 文件路径（绝对路径或相对路径）
     * @param exclusions - 排除配置
     * @returns 如果文件应该被排除，返回true
     */
    shouldExclude(filePath: string, exclusions: { files?: string[]; directories?: string[] }): boolean {
        if (!exclusions) {
            return false;
        }

        // 将文件路径标准化（统一使用正斜杠）
        const normalizedPath = filePath.replace(/\\/g, '/');
        const fileName = path.basename(normalizedPath);

        // 检查文件模式
        if (exclusions.files) {
            for (const pattern of exclusions.files) {
                // 将glob模式转换为正则表达式
                // 例如: *.log -> .*\.log, test-*.ts -> test-.*\.ts
                const regexPattern = pattern
                    .replace(/\*\*/g, '.*')  // ** 匹配任意路径
                    .replace(/\*/g, '[^/]*')  // * 匹配除/外的任意字符
                    .replace(/\./g, '\\.');   // . 转义为 \.
                
                try {
                    const regex = new RegExp(`^${regexPattern}$`);
                    // 检查文件名或完整路径是否匹配
                    if (regex.test(fileName) || regex.test(normalizedPath)) {
                        return true;
                    }
                } catch {
                    // 如果正则表达式无效，使用简单的字符串包含检查
                    if (normalizedPath.includes(pattern.replace(/\*/g, ''))) {
                        return true;
                    }
                }
            }
        }

        // 检查目录
        if (exclusions.directories && exclusions.directories.length > 0) {
            for (const dir of exclusions.directories) {
                // 检查文件路径是否包含该目录
                // 例如: node_modules 会匹配所有包含 node_modules 的路径
                if (normalizedPath.includes(dir.replace(/\\/g, '/'))) {
                    return true;
                }
            }
        }

        return false;
    }
}
