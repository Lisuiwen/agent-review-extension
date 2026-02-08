#!/usr/bin/env node
/**
 * Git Hook Runner - 独立运行的脚本，用于在 git hooks 中执行代码审查
 * 不依赖 VSCode API，可以直接通过 Node.js 执行
 */

import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { minimatch } from 'minimatch';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
// 大文件阈值：避免 hook 读取超大文件导致卡顿
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
// 二进制检测读取的字节数
const BINARY_CHECK_BYTES = 8000;
const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');
const matchPattern = (filePath: string, pattern: string) => {
    const normalizedPath = normalizePath(filePath);
    const normalizedPattern = pattern.replace(/\\/g, '/').trim();
    if (!normalizedPattern) {
        return false;
    }
    const hasPathSeparator = normalizedPattern.includes('/');
    return minimatch(normalizedPath, normalizedPattern, {
        dot: true,
        matchBase: !hasPathSeparator,
    }) || minimatch(path.basename(normalizedPath), normalizedPattern, { dot: true });
};
const isBinaryFile = async (filePath: string) => {
    try {
        const fileHandle = await fs.promises.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(BINARY_CHECK_BYTES);
            const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
            for (let i = 0; i < bytesRead; i++) {
                if (buffer[i] === 0) {
                    return true;
                }
            }
            return false;
        } finally {
            await fileHandle.close();
        }
    } catch (error) {
        console.error(`[WARN] 二进制检测失败，继续按文本处理: ${filePath}`, error);
        return false;
    }
};

// 简化的配置接口
interface AgentReviewConfig {
    version: string;
    rules: {
        enabled: boolean;
        strict_mode: boolean;
        builtin_rules_enabled?: boolean;  // 是否启用内置规则引擎
        code_quality?: { enabled: boolean; action: string; no_todo?: boolean; no_todo_pattern?: string };
        naming_convention?: { enabled: boolean; action: string; no_space_in_filename?: boolean };
    };
    git_hooks?: {
        allow_commit_once?: boolean;
    };
    exclusions?: {
        files?: string[];
        directories?: string[];
    };
}

// 简化的配置管理器，不依赖 VSCode API
class StandaloneConfigManager {
    private config: AgentReviewConfig | null = null;
    private configPath: string;

    constructor(workspaceRoot: string) {
        this.configPath = path.join(workspaceRoot, '.agentreview.yaml');
    }

    async loadConfig(): Promise<AgentReviewConfig> {
        const defaultConfig: AgentReviewConfig = {
            version: '1.0',
            rules: {
                enabled: true,
                strict_mode: false,
                naming_convention: {
                    enabled: true,
                    action: 'block_commit',
                    no_space_in_filename: true,
                },
                code_quality: {
                    enabled: true,
                    action: 'warning',
                    no_todo: true,
                },
            },
            git_hooks: {
                allow_commit_once: true,
            },
        };

        if (!fs.existsSync(this.configPath)) {
            this.config = defaultConfig;
            return this.config;
        }

        try {
            const fileContent = await fs.promises.readFile(this.configPath, 'utf-8');
            const userConfig = yaml.load(fileContent) as Partial<AgentReviewConfig>;
            this.config = { ...defaultConfig, ...userConfig };
            return this.config;
        } catch (error) {
            console.error(`[WARN] 加载配置文件失败，使用默认配置: ${error}`);
            this.config = defaultConfig;
            return this.config;
        }
    }

    getConfig(): AgentReviewConfig {
        return this.config || this.getDefaultConfig();
    }

    private getDefaultConfig(): AgentReviewConfig {
        return {
            version: '1.0',
            rules: {
                enabled: true,
                strict_mode: false,
                naming_convention: {
                    enabled: true,
                    action: 'block_commit',
                    no_space_in_filename: true,
                },
                code_quality: {
                    enabled: true,
                    action: 'warning',
                    no_todo: true,
                },
            },
            git_hooks: {
                allow_commit_once: true,
            },
        };
    }
}

// 简化的文件扫描器
class StandaloneFileScanner {
    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    async getStagedFiles(): Promise<string[]> {
        try {
            const { stdout } = await execAsync('git diff --cached --name-only', {
                cwd: this.workspaceRoot,
                encoding: 'utf-8',
            });

            return stdout
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(file => path.isAbsolute(file) ? file : path.join(this.workspaceRoot, file));
        } catch (error: any) {
            if (error.code === 1) {
                return [];
            }
            throw error;
        }
    }
}

// 简化的规则引擎
interface ReviewIssue {
    file: string;
    line: number;
    column: number;
    message: string;
    rule: string;
    severity: 'error' | 'warning' | 'info';
}

class StandaloneRuleEngine {
    private config: AgentReviewConfig;

    constructor(config: AgentReviewConfig) {
        this.config = config;
    }

    async checkFile(filePath: string, content: string): Promise<ReviewIssue[]> {
        const issues: ReviewIssue[] = [];

        // 检查是否启用内置规则引擎
        // 如果 builtin_rules_enabled 为 false 或未设置，则跳过内置规则检查
        const builtinRulesEnabled = this.config.rules.builtin_rules_enabled !== false && this.config.rules.enabled;
        if (!builtinRulesEnabled) {
            return issues;
        }

        // 检查文件名空格
        if (this.config.rules.naming_convention?.enabled && this.config.rules.naming_convention.no_space_in_filename) {
            const fileName = path.basename(filePath);
            if (fileName.includes(' ')) {
                const severity = this.getSeverity(this.config.rules.naming_convention.action);
                issues.push({
                    file: filePath,
                    line: 1,
                    column: 1,
                    message: `文件名包含空格: ${fileName}`,
                    rule: 'no_space_in_filename',
                    severity,
                });
            }
        }

        // 检查 TODO
        // 从配置读取正则表达式模式，如果没有配置则使用默认值
        if (this.config.rules.code_quality?.enabled && this.config.rules.code_quality.no_todo) {
            const todoPattern = this.config.rules.code_quality.no_todo_pattern || '(TODO|FIXME|XXX)';
            const todoRegex = new RegExp(todoPattern, 'i');
            const lines = content.split('\n');
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const match = line.match(todoRegex);
                if (match) {
                    const severity = this.getSeverity(this.config.rules.code_quality.action);
                    const column = line.indexOf(match[0]) + 1;
                    issues.push({
                        file: filePath,
                        line: i + 1,
                        column,
                        message: `发现 ${match[0]} 注释: ${line.trim()}`,
                        rule: 'no_todo',
                        severity,
                    });
                }
            }
        }

        return issues;
    }

    private getSeverity(action: string): 'error' | 'warning' | 'info' {
        switch (action) {
            case 'block_commit':
                return 'error';
            case 'warning':
                return 'warning';
            case 'log':
                return 'info';
            default:
                return 'warning';
        }
    }
}

async function main() {
    // 获取工作区根目录（从环境变量或当前目录）
    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
    
    if (!fs.existsSync(path.join(workspaceRoot, '.git'))) {
        console.error('错误: 未找到 .git 目录，请确保在 git 仓库中运行');
        process.exit(1);
    }

    try {
        // 初始化配置管理器
        const configManager = new StandaloneConfigManager(workspaceRoot);
        const config = await configManager.loadConfig();
        const allowCommitOnceEnabled = config.git_hooks?.allow_commit_once !== false;
        const allowCommitTokenPath = path.join(workspaceRoot, '.git', 'agentreview', 'allow-commit');

        // 若存在一次性放行标记，则跳过审查并清理标记
        if (allowCommitOnceEnabled && fs.existsSync(allowCommitTokenPath)) {
            try {
                await fs.promises.unlink(allowCommitTokenPath);
            } catch (error) {
                console.error('[WARN] 放行标记清理失败，仍将继续放行提交:', error);
            }
            console.error('✓ 检测到一次性放行标记，本次提交已放行');
            process.exit(0);
        }

        // 初始化文件扫描器
        const fileScanner = new StandaloneFileScanner(workspaceRoot);
        const stagedFiles = await fileScanner.getStagedFiles();

        if (stagedFiles.length === 0) {
            console.error('✓ 没有 staged 文件需要审查');
            process.exit(0);
        }

        // 初始化规则引擎
        const ruleEngine = new StandaloneRuleEngine(config);

        // 过滤排除的文件
        const filteredFiles = stagedFiles.filter(file => {
            if (config.exclusions) {
                // 简单的排除检查（hookRunner中简化实现）
                const normalizedPath = normalizePath(file);
                if (config.exclusions.directories) {
                    for (const dir of config.exclusions.directories) {
                        const normalizedDir = dir.replace(/\\/g, '/').replace(/\/+$/g, '').trim();
                        if (!normalizedDir) {
                            continue;
                        }
                        const hasGlob = /[*?[\]{]/.test(normalizedDir);
                        if (hasGlob) {
                            if (minimatch(normalizedPath, normalizedDir, { dot: true }) ||
                                minimatch(normalizedPath, `**/${normalizedDir}/**`, { dot: true })) {
                                return false;
                            }
                        } else {
                            if (normalizedPath.includes(`/${normalizedDir}/`) || normalizedPath.endsWith(`/${normalizedDir}`)) {
                                return false;
                            }
                        }
                    }
                }
                if (config.exclusions.files) {
                    for (const pattern of config.exclusions.files) {
                        // 使用 minimatch 支持完整 glob 语法
                        if (matchPattern(normalizedPath, pattern)) {
                            return false;
                        }
                    }
                }
            }
            return true;
        });

        // 执行审查
        const allIssues: ReviewIssue[] = [];
        for (const file of filteredFiles) {
            try {
                if (!fs.existsSync(file)) {
                    continue;
                }
                const stat = await fs.promises.stat(file);
                if (stat.size > MAX_FILE_SIZE_BYTES) {
                    console.error(`[WARN] 文件过大，已跳过: ${file} (${stat.size} bytes)`);
                    continue;
                }
                const binary = await isBinaryFile(file);
                if (binary) {
                    console.error(`[WARN] 二进制文件已跳过: ${file}`);
                    continue;
                }
                const content = await fs.promises.readFile(file, 'utf-8');
                const issues = await ruleEngine.checkFile(file, content);
                allIssues.push(...issues);
            } catch (error) {
                console.error(`[WARN] 检查文件失败: ${file}`);
            }
        }

        // 分类问题
        const errors = allIssues.filter(i => i.severity === 'error');
        const warnings = allIssues.filter(i => i.severity === 'warning');
        const info = allIssues.filter(i => i.severity === 'info');

        // 输出结果
        if (errors.length > 0) {
            console.error('\n❌ 代码审查失败，发现以下问题：\n');
            
            // 按文件分组输出错误
            const fileMap = new Map<string, ReviewIssue[]>();
            for (const error of errors) {
                if (!fileMap.has(error.file)) {
                    fileMap.set(error.file, []);
                }
                fileMap.get(error.file)!.push(error);
            }

            for (const [file, fileErrors] of fileMap.entries()) {
                console.error(`文件: ${file}`);
                for (const error of fileErrors) {
                    console.error(`  行 ${error.line}, 列 ${error.column}: ${error.message} [${error.rule}]`);
                }
                console.error('');
            }

            // 如果有 block_commit 的错误，退出码为 1
            const hasBlockingErrors = errors.some(error => {
                if (error.rule === 'no_space_in_filename') {
                    return config.rules.naming_convention?.action === 'block_commit';
                }
                if (error.rule === 'no_todo') {
                    return config.rules.code_quality?.action === 'block_commit';
                }
                return false;
            });

            if (config.rules.strict_mode || hasBlockingErrors) {
                console.error('提交已被阻止，请修复上述问题后重试。');
                process.exit(1);
            }
        }

        if (warnings.length > 0) {
            console.error(`\n⚠️  发现 ${warnings.length} 个警告（不影响提交）\n`);
        }

        if (errors.length === 0) {
            console.error('✓ 代码审查通过');
            process.exit(0);
        } else {
            process.exit(0); // 有错误但不阻止提交（非 block_commit）
        }
    } catch (error: any) {
        console.error('审查过程出错:', error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// 执行主函数
main().catch(error => {
    console.error('未处理的错误:', error);
    process.exit(1);
});
