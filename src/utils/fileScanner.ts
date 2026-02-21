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
import { minimatch } from 'minimatch';
import { exec } from 'child_process';  // Node.js 的进程执行模块
import { promisify } from 'util';      // 将回调函数转换为 Promise
import { Logger } from './logger';
import { parseUnifiedDiff } from './diffParser';
import type { FileDiff } from './diffTypes';

// 将 exec 转换为 Promise 形式，方便使用 async/await
const execAsync = promisify(exec);
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const COMMENT_ONLY_IGNORE_REGEX = [
    '^[[:space:]]*//',
    '^[[:space:]]*#',
    '^[[:space:]]*/\\*',
    '^[[:space:]]*\\*',
    '^[[:space:]]*\\*/',
    '^[[:space:]]*<!--',
    '^[[:space:]]*-->',
];

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
        // 强制显示日志通道，确保日志可见
        this.logger.show();
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
        } catch (error: unknown) {
            // Git 可能因非仓库、无 staged 文件或未安装而失败
            const code = (error as { code?: number })?.code;
            const msg = (error as Error)?.message ?? String(error);
            if (code === 1 || msg.includes('not a git repository')) {
                this.logger.debug('未找到git仓库或没有staged文件');
                return [];
            }
            this.logger.error('获取staged文件失败', error);
            return [];
        }
    }

    /**
     * 获取 Git staged 的 diff，解析为每文件的变更 hunks
     * 用于增量审查：仅对变更行做规则与 AI 审查
     *
     * @param files - 可选，只取这些文件的 diff；不传则取全部 staged
     * @returns Map：键为文件绝对路径，值为该文件的 FileDiff
     */
    async getStagedDiff(files?: string[]): Promise<Map<string, FileDiff>> {
        return this.getDiffByMode('staged', files);
    }

    /**
     * 获取工作区（未暂存）diff，解析为每文件的变更 hunks。
     *
     * 主要用于“保存触发审查”场景：文件还未 git add，也能识别是否仅格式变更。
     */
    async getWorkingDiff(files?: string[]): Promise<Map<string, FileDiff>> {
        return this.getDiffByMode('working', files);
    }

    /**
     * 获取「待提交增量」的 diff（基于 HEAD..WorkingTree）。
     * 用于默认审查入口：同时覆盖 staged + unstaged + untracked。
     */
    async getPendingDiff(files?: string[]): Promise<Map<string, FileDiff>> {
        return this.getDiffByMode('pending', files);
    }

    /**
     * 按模式获取 diff：
     * - staged: git diff --cached
     * - working: git diff
     *
     * 两种模式都会执行“原始 diff + 语义 diff（忽略空白）”双通道比较，
     * 产出 formatOnly 标记，供 ReviewEngine 在发 AI 前做降噪过滤。
     */
    private async getDiffByMode(mode: 'staged' | 'working' | 'pending', files?: string[]): Promise<Map<string, FileDiff>> {
        if (!this.workspaceRoot) {
            this.logger.warn(`未找到工作区，无法获取 ${mode} diff`);
            return new Map();
        }
        try {
            const buildFileArgs = (): string => {
                if (!files || files.length === 0) {
                    return '';
                }
                const relPaths = files
                    .map(f => (path.isAbsolute(f) ? path.relative(this.workspaceRoot!, f) : f))
                    .filter(Boolean)
                    .map(p => p.replace(/\\/g, '/'));
                if (relPaths.length === 0) {
                    return '';
                }
                const quoted = relPaths.map(p => (p.includes(' ') ? `"${p}"` : p));
                return ' -- ' + quoted.join(' ');
            };

            const fileArgs = buildFileArgs();
            const pendingBaseRef = mode === 'pending'
                ? await this.resolvePendingDiffBaseRef()
                : null;
            const diffBase = mode === 'staged'
                ? 'git diff --cached'
                : mode === 'working'
                    ? 'git diff'
                    : `git diff ${pendingBaseRef}`;
            const rawDiffCmd = `${diffBase} -U3 --no-color${fileArgs}`;
            const rawDiffResult = await execAsync(rawDiffCmd, {
                cwd: this.workspaceRoot,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
            });
            if (rawDiffResult.stderr && !rawDiffResult.stdout) {
                this.logger.debug('仅有 stderr 无 stdout，返回空 Map', rawDiffResult.stderr);
                return new Map();
            }

            const parsed = parseUnifiedDiff(rawDiffResult.stdout || '');
            const map = new Map<string, FileDiff>();
            for (const fd of parsed) {
                const absPath = path.isAbsolute(fd.path)
                    ? fd.path
                    : path.join(this.workspaceRoot, fd.path);
                const normalizedPath = path.normalize(absPath);
                map.set(normalizedPath, { ...fd, path: normalizedPath });
            }

            // 第二次用 -w 取“忽略空白”的 diff：
            // 若某文件在普通 diff 中存在、但在 -w diff 中消失，则可判定为“仅格式/空白变更”。
            // -w：忽略空格/缩进等空白差异；--ignore-blank-lines：仅增删空行视为无变更；
            // --ignore-cr-at-eol：行尾 CRLF/LF 差异视为无变更（常见于 Vue/跨平台格式整理）。
            const whitespaceInsensitiveCmd = `${diffBase} -U3 --no-color -w --ignore-blank-lines --ignore-cr-at-eol${fileArgs}`;
            const whitespaceInsensitiveResult = await execAsync(whitespaceInsensitiveCmd, {
                cwd: this.workspaceRoot,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
            });
            const commentInsensitiveIgnoreArgs = COMMENT_ONLY_IGNORE_REGEX
                .map(pattern => ` -I "${pattern}"`)
                .join('');
            const commentInsensitiveCmd = `${diffBase} -U3 --no-color -w --ignore-blank-lines --ignore-cr-at-eol${commentInsensitiveIgnoreArgs}${fileArgs}`;
            const commentInsensitiveResult = await execAsync(commentInsensitiveCmd, {
                cwd: this.workspaceRoot,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
            });
            const semanticDiffSet = new Set<string>(
                parseUnifiedDiff(whitespaceInsensitiveResult.stdout || '')
                    .map(item => path.isAbsolute(item.path) ? item.path : path.join(this.workspaceRoot!, item.path))
                    .map(item => path.normalize(item))
            );
            const commentSemanticDiffSet = new Set<string>(
                parseUnifiedDiff(commentInsensitiveResult.stdout || '')
                    .map(item => path.isAbsolute(item.path) ? item.path : path.join(this.workspaceRoot!, item.path))
                    .map(item => path.normalize(item))
            );
            for (const [filePath, fileDiff] of map.entries()) {
                const normalizedPath = path.normalize(filePath);
                const formatOnly = !semanticDiffSet.has(normalizedPath);
                map.set(filePath, {
                    ...fileDiff,
                    formatOnly,
                    commentOnly: !formatOnly && !commentSemanticDiffSet.has(normalizedPath),
                });
            }

            // working/pending 不包含 untracked；将未跟踪的新文件纳入为“全量新增”的 diff
            if (mode === 'working' || mode === 'pending') {
                const untrackedFiles = await this.getUntrackedFiles(fileArgs);
                for (const filePath of untrackedFiles) {
                    const normalizedPath = path.normalize(filePath);
                    if (map.has(normalizedPath)) continue;
                    const fileDiff = await this.buildUntrackedFileDiff(normalizedPath);
                    map.set(normalizedPath, fileDiff);
                }
            }

            if (map.size > 0) {
                this.logger.info(`解析到 ${map.size} 个文件的 ${mode} diff`);
            }
            return map;
        } catch (error: unknown) {
            const code = (error as { code?: number })?.code;
            const msg = (error as Error)?.message ?? String(error);
            if (code === 1 || msg.includes('not a git repository')) {
                this.logger.debug(`无 ${mode} diff 或非 git 仓库`);
                return new Map();
            }
            this.logger.error(`获取 ${mode} diff 失败`, error);
            return new Map();
        }
    }

    private async resolvePendingDiffBaseRef(): Promise<string> {
        if (!this.workspaceRoot) {
            return 'HEAD';
        }
        try {
            await execAsync('git rev-parse --verify HEAD', {
                cwd: this.workspaceRoot,
                encoding: 'utf-8',
            });
            return 'HEAD';
        } catch {
            return EMPTY_TREE_HASH;
        }
    }

    /** 为未跟踪文件构造 FileDiff（读入全文为单一 hunk，含 addedLines/addedContentLines） */
    private async buildUntrackedFileDiff(normalizedPath: string): Promise<FileDiff> {
        let hunks: FileDiff['hunks'] = [];
        try {
            const content = await fs.promises.readFile(normalizedPath, 'utf-8');
            const lines = content.length > 0 ? content.split(/\r?\n/) : [];
            hunks = lines.length > 0
                ? [{ newStart: 1, newCount: lines.length, lines }]
                : [];
        } catch {
            // 文件读不到时保守回退为无 hunk，上层按整文件路径继续审查
        }
        const addedLines = hunks.reduce((sum, h) => sum + h.newCount, 0);
        return {
            path: normalizedPath,
            hunks,
            formatOnly: false,
            commentOnly: false,
            addedLines,
            deletedLines: 0,
            addedContentLines: hunks.flatMap(h => h.lines),
        };
    }

    private async getUntrackedFiles(fileArgs: string): Promise<string[]> {
        if (!this.workspaceRoot) {
            return [];
        }
        const command = `git ls-files --others --exclude-standard${fileArgs}`;
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: this.workspaceRoot,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
            });
            if (stderr && !stdout) {
                return [];
            }
            return stdout
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(file => path.isAbsolute(file) ? file : path.join(this.workspaceRoot!, file));
        } catch {
            return [];
        }
    }

    async getChangedFiles(): Promise<string[]> {
        // TODO: 获取变更文件列表
        this.logger.info('获取变更文件');
        return [];
    }

    /** 读取文件内容，UTF-8；失败时抛出错误由调用方处理 */
    async readFile(filePath: string): Promise<string> {
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
        const matchPattern = (pattern: string): boolean => {
            const normalizedPattern = pattern.replace(/\\/g, '/').trim();
            if (!normalizedPattern) {
                return false;
            }
            const hasPathSeparator = normalizedPattern.includes('/');
            return minimatch(normalizedPath, normalizedPattern, {
                dot: true,
                matchBase: !hasPathSeparator,
            }) || minimatch(fileName, normalizedPattern, { dot: true });
        };

        // 检查文件模式
        if (exclusions.files) {
            for (const pattern of exclusions.files) {
                // 使用 minimatch 支持完整 glob 语法（如 {a,b}、[0-9]）
                if (matchPattern(pattern)) {
                    return true;
                }
            }
        }

        // 检查目录
        if (exclusions.directories && exclusions.directories.length > 0) {
            for (const dir of exclusions.directories) {
                const normalizedDir = dir.replace(/\\/g, '/').replace(/\/+$/g, '').trim();
                if (!normalizedDir) {
                    continue;
                }
                const hasGlob = /[*?[\]{]/.test(normalizedDir);
                if (hasGlob) {
                    if (minimatch(normalizedPath, normalizedDir, { dot: true }) ||
                        minimatch(normalizedPath, `**/${normalizedDir}/**`, { dot: true })) {
                        return true;
                    }
                } else {
                    // 例如: node_modules 会匹配所有包含 node_modules 的路径
                    if (normalizedPath.includes(`/${normalizedDir}/`) || normalizedPath.endsWith(`/${normalizedDir}`)) {
                        return true;
                    }
                }
            }
        }

        return false;
    }
}
