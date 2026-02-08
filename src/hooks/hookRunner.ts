#!/usr/bin/env node
/**
 * Git Hook Runner - 独立运行的脚本，用于在 git hooks 中执行代码审查
 * 不依赖 VSCode API，使用 shared 层（ruleChecks、standaloneConfigLoader、standaloneFileScanner）
 */

import * as path from 'path';
import * as fs from 'fs';
import { minimatch } from 'minimatch';
import { loadStandaloneConfig } from '../shared/standaloneConfigLoader';
import { getStagedFiles } from '../shared/standaloneFileScanner';
import { checkNoSpaceInFilename, checkNoTodo } from '../shared/ruleChecks';
import type { ReviewIssue } from '../types/review';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const BINARY_CHECK_BYTES = 8000;

const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');
const matchPattern = (filePath: string, pattern: string) => {
    const normalizedPath = normalizePath(filePath);
    const normalizedPattern = pattern.replace(/\\/g, '/').trim();
    if (!normalizedPattern) return false;
    const hasPathSeparator = normalizedPattern.includes('/');
    return minimatch(normalizedPath, normalizedPattern, { dot: true, matchBase: !hasPathSeparator })
        || minimatch(path.basename(normalizedPath), normalizedPattern, { dot: true });
};

const isBinaryFile = async (filePath: string): Promise<boolean> => {
    try {
        const fileHandle = await fs.promises.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(BINARY_CHECK_BYTES);
            const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
            for (let i = 0; i < bytesRead; i++) {
                if (buffer[i] === 0) return true;
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

async function main() {
    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();

    if (!fs.existsSync(path.join(workspaceRoot, '.git'))) {
        console.error('错误: 未找到 .git 目录，请确保在 git 仓库中运行');
        process.exit(1);
    }

    try {
        const config = await loadStandaloneConfig(workspaceRoot);
        const allowCommitOnceEnabled = config.git_hooks?.allow_commit_once !== false;
        const allowCommitTokenPath = path.join(workspaceRoot, '.git', 'agentreview', 'allow-commit');

        if (allowCommitOnceEnabled && fs.existsSync(allowCommitTokenPath)) {
            try {
                await fs.promises.unlink(allowCommitTokenPath);
            } catch (error) {
                console.error('[WARN] 放行标记清理失败，仍将继续放行提交:', error);
            }
            console.error('✓ 检测到一次性放行标记，本次提交已放行');
            process.exit(0);
        }

        const stagedFiles = await getStagedFiles(workspaceRoot);
        if (stagedFiles.length === 0) {
            console.error('✓ 没有 staged 文件需要审查');
            process.exit(0);
        }

        const builtinRulesEnabled = config.rules.builtin_rules_enabled !== false && config.rules.enabled;

        const filteredFiles = stagedFiles.filter((file) => {
            if (config.exclusions) {
                const normalizedPath = normalizePath(file);
                if (config.exclusions.directories) {
                    for (const dir of config.exclusions.directories) {
                        const normalizedDir = dir.replace(/\\/g, '/').replace(/\/+$/g, '').trim();
                        if (!normalizedDir) continue;
                        const hasGlob = /[*?[\]{]/.test(normalizedDir);
                        if (hasGlob) {
                            if (minimatch(normalizedPath, normalizedDir, { dot: true }) ||
                                minimatch(normalizedPath, `**/${normalizedDir}/**`, { dot: true }))
                                return false;
                        } else {
                            if (normalizedPath.includes(`/${normalizedDir}/`) || normalizedPath.endsWith(`/${normalizedDir}`))
                                return false;
                        }
                    }
                }
                if (config.exclusions.files) {
                    for (const pattern of config.exclusions.files) {
                        if (matchPattern(normalizedPath, pattern)) return false;
                    }
                }
            }
            return true;
        });

        const allIssues: ReviewIssue[] = [];
        for (const file of filteredFiles) {
            try {
                if (!fs.existsSync(file)) continue;
                const stat = await fs.promises.stat(file);
                if (stat.size > MAX_FILE_SIZE_BYTES) {
                    console.error(`[WARN] 文件过大，已跳过: ${file} (${stat.size} bytes)`);
                    continue;
                }
                if (await isBinaryFile(file)) {
                    console.error(`[WARN] 二进制文件已跳过: ${file}`);
                    continue;
                }
                const content = await fs.promises.readFile(file, 'utf-8');
                if (!builtinRulesEnabled) continue;

                if (config.rules.naming_convention?.enabled && config.rules.naming_convention.no_space_in_filename) {
                    allIssues.push(...checkNoSpaceInFilename(file, content, { action: config.rules.naming_convention.action }));
                }
                if (config.rules.code_quality?.enabled && config.rules.code_quality.no_todo) {
                    allIssues.push(...checkNoTodo(file, content, {
                        action: config.rules.code_quality.action,
                        pattern: config.rules.code_quality.no_todo_pattern,
                    }));
                }
            } catch (error) {
                console.error(`[WARN] 检查文件失败: ${file}`);
            }
        }

        const errors = allIssues.filter(i => i.severity === 'error');
        const warnings = allIssues.filter(i => i.severity === 'warning');

        if (errors.length > 0) {
            console.error('\n❌ 代码审查失败，发现以下问题：\n');
            const fileMap = new Map<string, ReviewIssue[]>();
            for (const error of errors) {
                if (!fileMap.has(error.file)) fileMap.set(error.file, []);
                fileMap.get(error.file)!.push(error);
            }
            for (const [file, fileErrors] of fileMap.entries()) {
                console.error(`文件: ${file}`);
                for (const error of fileErrors) {
                    console.error(`  行 ${error.line}, 列 ${error.column}: ${error.message} [${error.rule}]`);
                }
                console.error('');
            }
            const hasBlockingErrors = errors.some(error => {
                if (error.rule === 'no_space_in_filename')
                    return config.rules.naming_convention?.action === 'block_commit';
                if (error.rule === 'no_todo')
                    return config.rules.code_quality?.action === 'block_commit';
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
        }
        process.exit(0);
    } catch (error: any) {
        console.error('审查过程出错:', error.message);
        if (error.stack) console.error(error.stack);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('未处理的错误:', error);
    process.exit(1);
});
