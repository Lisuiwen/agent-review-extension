/**
 * 规则引擎
 * 
 * 这个文件负责执行具体的代码规则检查
 * 
 * 主要功能：
 * 1. 读取配置文件中的规则设置
 * 2. 对每个文件应用启用的规则
 * 3. 返回发现的问题列表
 * 
 * 当前实现的规则（可通过配置启用/禁用）：
 * - no_space_in_filename: 检查文件名是否包含空格
 *   - 配置路径：rules.naming_convention.no_space_in_filename
 * - no_todo: 检查代码中是否包含 TODO/FIXME/XXX 注释
 *   - 配置路径：rules.code_quality.no_todo
 *   - 可配置参数：no_todo_pattern（正则表达式模式，默认：'(TODO|FIXME|XXX)'）
 * 
 * 规则检查流程：
 * 1. 读取文件内容
 * 2. 根据配置决定应用哪些规则（通过 rules.builtin_rules_enabled 控制是否启用内置规则引擎）
 * 3. 对每个规则执行检查
 * 4. 根据规则的 action 设置问题的严重程度
 * 5. 返回所有发现的问题
 * 
 * 注意：
 * - 内置规则引擎默认禁用（builtin_rules_enabled: false），避免与项目自有规则冲突
 * - 如需启用，在配置文件中设置 rules.builtin_rules_enabled: true
 */

import { ConfigManager } from '../config/configManager';
import { Logger } from '../utils/logger';
import type { ReviewIssue } from '../types/review';
import type { FileDiff } from '../utils/diffTypes';
import { checkNoSpaceInFilename, checkNoTodo } from '../shared/ruleChecks';
import * as path from 'path';
import * as fs from 'fs';
import { RuntimeTraceLogger, type RuntimeTraceSession } from '../utils/runtimeTraceLogger';

/**
 * 规则接口（未来扩展用）
 * 目前规则配置直接读取自配置文件，这个接口预留用于未来功能
 */
export interface Rule {
    name: string;
    enabled: boolean;
    action: 'block_commit' | 'warning' | 'log';
}

/**
 * 规则引擎类
 * 
 * 使用方式：
 * ```typescript
 * const ruleEngine = new RuleEngine(configManager);
 * const issues = await ruleEngine.checkFile(filePath, fileContent);
 * ```
 */
export class RuleEngine {
    private configManager: ConfigManager;
    private logger: Logger;
    private runtimeTraceLogger: RuntimeTraceLogger;
    private rules: Rule[] = [];
    // 大文件阈值：超过该大小的文件将被跳过，避免内存占用过高
    private static readonly MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
    // 二进制检测读取的字节数（仅用于快速判断）
    private static readonly BINARY_CHECK_BYTES = 8000;

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
        this.logger = new Logger('RuleEngine');
        this.runtimeTraceLogger = RuntimeTraceLogger.getInstance();
    }

    async initialize(): Promise<void> {
        this.logger.info('规则引擎初始化');
        // 规则配置在检查时动态读取，无需预加载
    }

    /**
     * 检查单个文件
     *
     * 当提供 fileDiff 时，no_todo 仅对变更行执行；文件名规则始终执行。
     *
     * @param filePath - 文件的完整路径
     * @param content - 文件的内容（字符串）
     * @param fileDiff - 可选，该文件的 diff；有则仅对变更行跑 no_todo
     * @returns 发现的问题列表
     */
    async checkFile(filePath: string, content: string, fileDiff?: FileDiff | null): Promise<ReviewIssue[]> {
        const result = this.checkFileWithMetrics(filePath, content, fileDiff);
        return result.issues;
    }

    private checkFileWithMetrics = (
        filePath: string,
        content: string,
        fileDiff?: FileDiff | null
    ): {
        issues: ReviewIssue[];
        candidateLines: number;
        checkedLines: number;
        skippedUnchangedLines: number;
    } => {
        const issues: ReviewIssue[] = [];
        const config = this.configManager.getConfig();
        let candidateLines = 0;
        let checkedLines = 0;

        if (!config.rules.enabled) {
            return {
                issues,
                candidateLines,
                checkedLines,
                skippedUnchangedLines: 0,
            };
        }

        // 规则1：文件名（与行无关，始终检查）
        if (config.rules.naming_convention?.enabled && config.rules.naming_convention.no_space_in_filename) {
            issues.push(
                ...checkNoSpaceInFilename(filePath, content, {
                    action: config.rules.naming_convention.action,
                })
            );
        }

        // 规则2：no_todo；有 fileDiff 时仅扫描变更行
        if (config.rules.code_quality?.enabled && config.rules.code_quality.no_todo) {
            let changedLineNumbers: Set<number> | undefined;
            candidateLines = content.split('\n').length;
            if (fileDiff?.hunks?.length) {
                changedLineNumbers = new Set<number>();
                for (const h of fileDiff.hunks) {
                    for (let k = 0; k < h.newCount; k++) {
                        changedLineNumbers.add(h.newStart + k);
                    }
                }
            }
            checkedLines = changedLineNumbers?.size ?? candidateLines;
            issues.push(
                ...checkNoTodo(filePath, content, {
                    action: config.rules.code_quality.action,
                    pattern: config.rules.code_quality.no_todo_pattern as string | undefined,
                }, changedLineNumbers)
            );
        }

        return {
            issues,
            candidateLines,
            checkedLines,
            skippedUnchangedLines: Math.max(0, candidateLines - checkedLines),
        };
    };

    /**
     * 批量检查多个文件
     *
     * 当传入 diffByFile 时，仅对变更行执行 no_todo（由 checkFile 内部根据 fileDiff 处理）。
     *
     * @param files - 要检查的文件路径数组
     * @param diffByFile - 可选，每文件的 diff；有则仅扫描变更行
     * @returns 所有文件的问题列表（合并后的）
     */
    async checkFiles(
        files: string[],
        diffByFile?: Map<string, FileDiff> | null,
        traceSession?: RuntimeTraceSession | null
    ): Promise<ReviewIssue[]> {
        const issues: ReviewIssue[] = [];
        const scanStartAt = Date.now();
        let skippedMissing = 0;
        let skippedLarge = 0;
        let skippedBinary = 0;
        let bytesRead = 0;
        let candidateLines = 0;
        let checkedLines = 0;
        let skippedUnchangedLines = 0;

        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'RuleEngine',
            event: 'rule_scan_start',
            phase: 'rules',
            data: {
                files: files.length,
                diffMode: !!diffByFile,
            },
        });

        for (const file of files) {
            try {
                if (!fs.existsSync(file)) {
                    this.logger.warn(`文件不存在: ${file}`);
                    skippedMissing++;
                    continue;
                }

                const stat = await fs.promises.stat(file);
                if (stat.size > RuleEngine.MAX_FILE_SIZE_BYTES) {
                    this.logger.warn(`文件过大，已跳过: ${file} (${stat.size} bytes)`);
                    skippedLarge++;
                    issues.push({
                        file,
                        line: 1,
                        column: 1,
                        message: `文件过大，已跳过审查（>${RuleEngine.MAX_FILE_SIZE_BYTES} bytes）`,
                        rule: 'file_skipped',
                        severity: 'warning',
                    });
                    continue;
                }

                const isBinary = await this.isBinaryFile(file);
                if (isBinary) {
                    this.logger.warn(`检测到二进制文件，已跳过: ${file}`);
                    skippedBinary++;
                    issues.push({
                        file,
                        line: 1,
                        column: 1,
                        message: '检测到二进制文件，已跳过审查',
                        rule: 'file_skipped',
                        severity: 'warning',
                    });
                    continue;
                }

                const content = await fs.promises.readFile(file, 'utf-8');
                bytesRead += Buffer.byteLength(content, 'utf8');
                const fileDiff = diffByFile?.get(file) ?? null;
                const checkResult = this.checkFileWithMetrics(file, content, fileDiff);
                candidateLines += checkResult.candidateLines;
                checkedLines += checkResult.checkedLines;
                skippedUnchangedLines += checkResult.skippedUnchangedLines;
                issues.push(...checkResult.issues);
            } catch (error) {
                this.logger.error(`检查文件失败: ${file}`, error);
            }
        }

        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'RuleEngine',
            event: 'rule_scan_summary',
            phase: 'rules',
            durationMs: Date.now() - scanStartAt,
            data: {
                filesScanned: files.length,
                skippedMissing,
                skippedLarge,
                skippedBinary,
                bytesRead,
            },
        });
        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'RuleEngine',
            event: 'rule_diff_filter_summary',
            phase: 'rules',
            data: {
                candidateLines,
                checkedLines,
                skippedUnchangedLines,
            },
        });

        return issues;
    }

    /**
     * 快速检测文件是否为二进制文件
     * 
     * 实现思路：
     * 1. 读取文件的前 N 个字节
     * 2. 如果包含 0x00（空字符），通常是二进制文件
     * 
     * @param filePath - 文件路径
     * @returns 是否为二进制文件
     */
    private isBinaryFile = async (filePath: string): Promise<boolean> => {
        try {
            const fileHandle = await fs.promises.open(filePath, 'r');
            try {
                const buffer = Buffer.alloc(RuleEngine.BINARY_CHECK_BYTES);
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
            // 如果读取失败，保守处理：不认为是二进制，让上层流程继续处理
            this.logger.debug(`二进制检测失败，继续按文本处理: ${filePath}`, error);
            return false;
        }
    };

    getRules(): Rule[] {
        return this.rules;
    }
}
