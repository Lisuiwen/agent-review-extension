/**
 * 鏂囦欢鎵弿鍣?
 * 
 * 这个文件负责与Git 浜や簰锛岃幏鍙栭渶瑕佸鏌ョ殑鏂囦欢鍒楄〃
 * 
 * 涓昏鍔熻兘锛?
 * 1. 获取 Git staged（已暂存）的文件列表
 * 2. 读取文件内容
 * 3. 检查文件是否在排除列表中
 * 
 * 工作原理：
 * - 使用 Git 命令 'git diff --cached --name-only' 获取 staged 文件
 * - 这个命令会返回所有已添加到暂存区的文件路径
 * 
 * 使用场景：
 * - 鐢ㄦ埛鎵ц瀹℃煡鍛戒护无
 * - Git pre-commit hook 鎵ц无
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { exec } from 'child_process';  // Node.js 的进程执行模块
import { promisify } from 'util';      // 灏嗗洖璋冨嚱鏁拌浆鎹负 Promise
import { Logger } from './logger';
import { parseUnifiedDiff } from './diffParser';
import type { FileDiff } from './diffTypes';
import { getEffectiveWorkspaceRoot } from './workspaceRoot';

// 灏?exec 杞崲涓?Promise 褰㈠紡锛屾柟渚夸娇鐢?async/await
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
 * 鏂囦欢鎵弿鍣ㄧ被
 * 
 * 使用方式：
 * ```typescript
 * const scanner = new FileScanner();
 * const stagedFiles = await scanner.getStagedFiles();
 * ```
 */
export class FileScanner {
    private logger: Logger;

    constructor() {
        this.logger = new Logger('FileScanner');
    }

    private resolveWorkspaceRoot = (workspaceRoot?: string): string | undefined => {
        if (workspaceRoot && workspaceRoot.trim().length > 0) return workspaceRoot;
        return getEffectiveWorkspaceRoot()?.uri.fsPath;
    };

    /**
     * 获取 Git staged（已暂存）的文件列表
     * 
     * 此方法使用 Git 命令获取所有已添加到暂存区的文件
     * 
     * Git 命令说明：
     * - git diff --cached: 显示已暂存（staged）的修改
     * - --name-only: 鍙樉绀烘枃浠跺悕锛屼笉鏄剧ず鍏蜂綋鏇存敼鍐呭
     * 
     * @returns 鏂囦欢璺緞鏁扮粍锛堢粷瀵硅矾寰勶級
     * 
     * 示例：
     * ```typescript
     * const files = await scanner.getStagedFiles();
     * // 返回: ['/path/to/file1.ts', '/path/to/file2.ts']
     * ```
     */
    async getStagedFiles(workspaceRoot?: string): Promise<string[]> {
        // 强制显示日志通道，确保日志可见
        this.logger.show();
        this.logger.info('鑾峰彇staged鏂囦欢');
        
        const resolvedWorkspaceRoot = this.resolveWorkspaceRoot(workspaceRoot);
        // 妫€鏌ユ槸鍚︽湁宸ヤ綔鍖?
        if (!resolvedWorkspaceRoot) {
            this.logger.warn('鏈壘鍒板伐浣滃尯锛屾棤娉曡幏鍙杝taged鏂囦欢');
            return [];
        }

        try {
            // 鎵ц Git 鍛戒护获取 staged 文件鍒楄〃
            // execAsync 浼氬湪鎸囧畾鐨勫伐浣滅洰褰曪紙cwd锛変腑鎵ц鍛戒护
            const { stdout, stderr } = await execAsync('git diff --cached --name-only', {
                cwd: resolvedWorkspaceRoot,  // 在工作区根目录执行命令
                encoding: 'utf-8',        // 指定输出编码为 UTF-8
            });

            // 濡傛灉鍙湁 stderr 娌℃湁 stdout锛屽彲鑳芥槸娌℃湁 staged 鏂囦欢鎴栦笉鏄?git 浠撳簱
            if (stderr && !stdout) {
                this.logger.debug(`Git鍛戒护杈撳嚭: ${stderr}`);
                return [];
            }

            // 解析 Git 命令的输出
            // Git 鍛戒护杩斿洖鐨勬槸姣忚涓€涓枃浠惰矾寰勭殑鏂囨湰
            const files = stdout
                .split('\n')                    // 鎸夎鍒嗗壊
                .map(line => line.trim())        // 鍘婚櫎姣忚鐨勯灏剧┖鏍?
                .filter(line => line.length > 0) // 过滤空行
                .map(file => 
                    // 灏嗙浉瀵硅矾寰勮浆鎹负缁濆璺緞
                    // path.isAbsolute 妫€鏌ヨ矾寰勬槸鍚︽槸缁濆璺緞
                    path.isAbsolute(file) 
                        ? file 
                        : path.join(resolvedWorkspaceRoot, file)
                );

            if (files.length > 0) {
                this.logger.info(`找到 ${files.length} 个 staged 文件`);
            }
            return files;
        } catch (error: unknown) {
            // Git 鍙兘鍥犻潪浠撳簱銆佹棤 staged 鏂囦欢鎴栨湭瀹夎鑰屽け璐?
            const code = (error as { code?: number })?.code;
            const msg = (error as Error)?.message ?? String(error);
            if (code === 1 || msg.includes('not a git repository')) {
                this.logger.debug('鏈壘鍒癵it浠撳簱鎴栨病鏈塻taged鏂囦欢');
                return [];
            }
            this.logger.error('获取 staged 文件失败', error);
            return [];
        }
    }

    /**
     * 获取 Git staged 的 diff，解析为每文件的变更 hunks
     * 鐢ㄤ簬澧為噺瀹℃煡锛氫粎瀵瑰彉鏇磋鍋氳鍒欎笌 AI 瀹℃煡
     *
     * @param files - 鍙€夛紝鍙彇杩欎簺鏂囦欢鐨?diff锛涗笉浼犲垯鍙栧叏閮?staged
     * @returns Map：键为文件绝对路径，值为该文件的 FileDiff
     */
    async getStagedDiff(workspaceRoot: string | undefined, files?: string[]): Promise<Map<string, FileDiff>> {
        return this.getDiffByMode('staged', workspaceRoot, files);
    }

    /**
     * 鑾峰彇宸ヤ綔鍖猴紙鏈殏瀛橈級diff锛岃В鏋愪负姣忔枃浠剁殑鍙樻洿 hunks銆?
     *
     * 涓昏鐢ㄤ簬鈥滀繚瀛樿Е鍙戝鏌モ€濆満鏅細鏂囦欢杩樻湭 git add锛屼篃鑳借瘑鍒槸鍚︿粎鏍煎紡鍙樻洿銆?
     */
    async getWorkingDiff(workspaceRoot: string | undefined, files?: string[]): Promise<Map<string, FileDiff>> {
        return this.getDiffByMode('working', workspaceRoot, files);
    }

    /**
     * 获取「待提交增量」的 diff（基于 HEAD..WorkingTree）。
     * 鐢ㄤ簬榛樿瀹℃煡鍏ュ彛锛氬悓鏃惰鐩?staged + unstaged + untracked銆?
     */
    async getPendingDiff(workspaceRoot: string | undefined, files?: string[]): Promise<Map<string, FileDiff>> {
        return this.getDiffByMode('pending', workspaceRoot, files);
    }

    /**
     * 按模式获取 diff：
     * - staged: git diff --cached
     * - working: git diff
     *
     * 涓ょ妯″紡閮戒細鎵ц鈥滃師濮?diff + 璇箟 diff锛堝拷鐣ョ┖鐧斤級鈥濆弻閫氶亾姣旇緝锛?
     * 浜у嚭 formatOnly 鏍囪锛屼緵 ReviewEngine 鍦ㄥ彂 AI 鍓嶅仛闄嶅櫔杩囨护銆?
     */
    private async getDiffByMode(mode: 'staged' | 'working' | 'pending', workspaceRoot: string | undefined, files?: string[]): Promise<Map<string, FileDiff>> {
        const resolvedWorkspaceRoot = this.resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot) {
            this.logger.warn(`鏈壘鍒板伐浣滃尯锛屾棤娉曡幏鍙?${mode} diff`);
            return new Map();
        }
        try {
            const buildFileArgs = (): string => {
                if (!files || files.length === 0) {
                    return '';
                }
                const relPaths = files
                    .map(f => (path.isAbsolute(f) ? path.relative(resolvedWorkspaceRoot, f) : f))
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
                ? await this.resolvePendingDiffBaseRef(resolvedWorkspaceRoot)
                : null;
            const diffBase = mode === 'staged'
                ? 'git diff --cached'
                : mode === 'working'
                    ? 'git diff'
                    : `git diff ${pendingBaseRef}`;
            const rawDiffCmd = `${diffBase} -U3 --no-color${fileArgs}`;
            const rawDiffResult = await execAsync(rawDiffCmd, {
                cwd: resolvedWorkspaceRoot,
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
                    : path.join(resolvedWorkspaceRoot, fd.path);
                const normalizedPath = path.normalize(absPath);
                map.set(normalizedPath, { ...fd, path: normalizedPath });
            }

            // 绗簩娆＄敤 -w 鍙栤€滃拷鐣ョ┖鐧解€濈殑 diff锛?
            // 鑻ユ煇鏂囦欢鍦ㄦ櫘閫?diff 涓瓨鍦ㄣ€佷絾鍦?-w diff 涓秷澶憋紝鍒欏彲鍒ゅ畾涓衡€滀粎鏍煎紡/绌虹櫧鍙樻洿鈥濄€?
            // -w锛氬拷鐣ョ┖鏍?缂╄繘绛夌┖鐧藉樊寮傦紱--ignore-blank-lines锛氫粎澧炲垹绌鸿瑙嗕负鏃犲彉鏇达紱
            // --ignore-cr-at-eol锛氳灏?CRLF/LF 宸紓瑙嗕负鏃犲彉鏇达紙甯歌浜?Vue/璺ㄥ钩鍙版牸寮忔暣鐞嗭級銆?
            const whitespaceInsensitiveCmd = `${diffBase} -U3 --no-color -w --ignore-blank-lines --ignore-cr-at-eol${fileArgs}`;
            const whitespaceInsensitiveResult = await execAsync(whitespaceInsensitiveCmd, {
                cwd: resolvedWorkspaceRoot,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
            });
            const commentInsensitiveIgnoreArgs = COMMENT_ONLY_IGNORE_REGEX
                .map(pattern => ` -I "${pattern}"`)
                .join('');
            const commentInsensitiveCmd = `${diffBase} -U3 --no-color -w --ignore-blank-lines --ignore-cr-at-eol${commentInsensitiveIgnoreArgs}${fileArgs}`;
            const commentInsensitiveResult = await execAsync(commentInsensitiveCmd, {
                cwd: resolvedWorkspaceRoot,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
            });
            const semanticDiffSet = new Set<string>(
                parseUnifiedDiff(whitespaceInsensitiveResult.stdout || '')
                    .map(item => path.isAbsolute(item.path) ? item.path : path.join(resolvedWorkspaceRoot, item.path))
                    .map(item => path.normalize(item))
            );
            const commentSemanticDiffSet = new Set<string>(
                parseUnifiedDiff(commentInsensitiveResult.stdout || '')
                    .map(item => path.isAbsolute(item.path) ? item.path : path.join(resolvedWorkspaceRoot, item.path))
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

            // working/pending 涓嶅寘鍚?untracked锛涘皢鏈窡韪殑鏂版枃浠剁撼鍏ヤ负鈥滃叏閲忔柊澧炩€濈殑 diff
            if (mode === 'working' || mode === 'pending') {
                const untrackedFiles = await this.getUntrackedFiles(resolvedWorkspaceRoot, fileArgs);
                for (const filePath of untrackedFiles) {
                    const normalizedPath = path.normalize(filePath);
                    if (map.has(normalizedPath)) continue;
                    const fileDiff = await this.buildUntrackedFileDiff(normalizedPath);
                    map.set(normalizedPath, fileDiff);
                }
            }

            if (map.size > 0) {
                this.logger.info(`解析到 ${map.size} 涓枃浠剁殑 ${mode} diff`);
            }
            return map;
        } catch (error: unknown) {
            const code = (error as { code?: number })?.code;
            const msg = (error as Error)?.message ?? String(error);
            if (code === 1 || msg.includes('not a git repository')) {
                this.logger.debug(`无${mode} diff 或非 git 仓库`);
                return new Map();
            }
            this.logger.error(`获取 ${mode} diff 失败`, error);
            return new Map();
        }
    }

    private async resolvePendingDiffBaseRef(workspaceRoot: string | undefined): Promise<string> {
        if (!workspaceRoot) {
            return 'HEAD';
        }
        try {
            await execAsync('git rev-parse --verify HEAD', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
            });
            return 'HEAD';
        } catch {
            return EMPTY_TREE_HASH;
        }
    }

    /** 涓烘湭璺熻釜鏂囦欢鏋勯€?FileDiff锛堣鍏ュ叏鏂囦负鍗曚竴 hunk锛屽惈 addedLines/addedContentLines锛?*/
    private async buildUntrackedFileDiff(normalizedPath: string): Promise<FileDiff> {
        let hunks: FileDiff['hunks'] = [];
        try {
            const content = await fs.promises.readFile(normalizedPath, 'utf-8');
            const lines = content.length > 0 ? content.split(/\r?\n/) : [];
            hunks = lines.length > 0
                ? [{ newStart: 1, newCount: lines.length, lines }]
                : [];
        } catch {
            // 鏂囦欢璇讳笉鍒版椂淇濆畧鍥為€€涓烘棤 hunk锛屼笂灞傛寜鏁存枃浠惰矾寰勭户缁鏌?
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

    private async getUntrackedFiles(workspaceRoot: string | undefined, fileArgs: string): Promise<string[]> {
        if (!workspaceRoot) {
            return [];
        }
        const command = `git ls-files --others --exclude-standard${fileArgs}`;
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: workspaceRoot,
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
                .map(file => path.isAbsolute(file) ? file : path.join(workspaceRoot, file));
        } catch {
            return [];
        }
    }

    async getChangedFiles(): Promise<string[]> {
        // TODO: 获取变更文件列表
        this.logger.info('获取变更文件');
        return [];
    }

    /** 读取文件内容锛孶TF-8锛涘け璐ユ椂鎶涘嚭閿欒鐢辫皟鐢ㄦ柟澶勭悊 */
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
     * 妫€鏌ユ枃浠舵槸鍚﹀簲璇ヨ鎺掗櫎
     * 
     * 鏀寔绠€鍗曠殑glob妯″紡鍖归厤锛?
     * - *.log 匹配所有 log 文件
     * - test-*.ts 匹配 test- 开头的 .ts 文件
     * - 鏀寔閫氶厤绗︽ā寮忓尮閰嶇洰褰曞拰鏂囦欢
     * 
     * @param filePath - 鏂囦欢璺緞锛堢粷瀵硅矾寰勬垨鐩稿璺緞锛?
     * @param exclusions - 排除配置
     * @returns 濡傛灉鏂囦欢搴旇琚帓闄わ紝杩斿洖true
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
                // 浣跨敤 minimatch 鏀寔瀹屾暣 glob 璇硶锛堝 {a,b}銆乕0-9]锛?
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
                    // 例如: node_modules 会匹配所有包含 node_modules 的路径
                    if (normalizedPath.includes(`/${normalizedDir}/`) || normalizedPath.endsWith(`/${normalizedDir}`)) {
                        return true;
                    }
                }
            }
        }

        return false;
    }
}


