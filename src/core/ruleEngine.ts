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
 * 当前实现的规则：
 * - no_space_in_filename: 检查文件名是否包含空格
 * - no_todo: 检查代码中是否包含 TODO/FIXME/XXX 注释
 * 
 * 规则检查流程：
 * 1. 读取文件内容
 * 2. 根据配置决定应用哪些规则
 * 3. 对每个规则执行检查
 * 4. 根据规则的 action 设置问题的严重程度
 * 5. 返回所有发现的问题
 */

import { ConfigManager } from '../config/configManager';
import { Logger } from '../utils/logger';
import { ReviewIssue } from './reviewEngine';
import * as path from 'path';
import * as fs from 'fs';

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
    private rules: Rule[] = [];
    // 大文件阈值：超过该大小的文件将被跳过，避免内存占用过高
    private static readonly MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
    // 二进制检测读取的字节数（仅用于快速判断）
    private static readonly BINARY_CHECK_BYTES = 8000;

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
        this.logger = new Logger('RuleEngine');
    }

    async initialize(): Promise<void> {
        this.logger.info('规则引擎初始化');
        // 规则配置在检查时动态读取，无需预加载
    }

    /**
     * 检查单个文件
     * 
     * 这个方法会对文件应用所有启用的规则，并返回发现的问题
     * 
     * @param filePath - 文件的完整路径
     * @param content - 文件的内容（字符串）
     * @returns 发现的问题列表
     */
    async checkFile(filePath: string, content: string): Promise<ReviewIssue[]> {
        this.logger.debug(`检查文件: ${filePath}`);
        const issues: ReviewIssue[] = [];
        const config = this.configManager.getConfig();

        // 如果全局规则未启用，直接返回空列表
        if (!config.rules.enabled) {
            return issues;
        }

        // 规则1：检查文件名是否包含空格
        // 这个规则属于 naming_convention（命名规范）规则组
        if (config.rules.naming_convention?.enabled && config.rules.naming_convention.no_space_in_filename) {
            // path.basename 获取文件名（不含路径）
            const fileName = path.basename(filePath);
            // 检查文件名中是否包含空格
            if (fileName.includes(' ')) {
                // 根据规则的 action 设置严重程度
                const severity = this.getSeverity(config.rules.naming_convention.action);
                issues.push({
                    file: filePath,
                    line: 1,      // 文件名问题，行号设为1
                    column: 1,    // 列号设为1
                    message: `文件名包含空格: ${fileName}`,
                    rule: 'no_space_in_filename',  // 规则标识符
                    severity,
                });
            }
        }

        // 规则2：检查代码中是否包含 TODO/FIXME/XXX 注释
        // 这个规则属于 code_quality（代码质量）规则组
        if (config.rules.code_quality?.enabled && config.rules.code_quality.no_todo) {
            // 使用正则表达式匹配 TODO、FIXME、XXX（不区分大小写）
            const todoRegex = /(TODO|FIXME|XXX)/i;
            // 将文件内容按行分割
            const lines = content.split('\n');
            
            // 遍历每一行
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // 检查这一行是否包含 TODO/FIXME/XXX
                const match = line.match(todoRegex);
                if (match) {
                    // 找到匹配，创建一个问题
                    const severity = this.getSeverity(config.rules.code_quality.action);
                    // 计算匹配文本在行中的位置（列号，从1开始）
                    const column = line.indexOf(match[0]) + 1;
                    issues.push({
                        file: filePath,
                        line: i + 1,  // 行号（从1开始）
                        column,        // 列号
                        message: `发现 ${match[0]} 注释: ${line.trim()}`,
                        rule: 'no_todo',  // 规则标识符
                        severity,
                    });
                }
            }
        }

        return issues;
    }

    /**
     * 批量检查多个文件
     * 
     * 这个方法会遍历文件列表，对每个文件调用 checkFile
     * 
     * @param files - 要检查的文件路径数组
     * @returns 所有文件的问题列表（合并后的）
     */
    async checkFiles(files: string[]): Promise<ReviewIssue[]> {
        const issues: ReviewIssue[] = [];
        
        // 遍历每个文件
        for (const file of files) {
            try {
                // 步骤1：检查文件是否存在
                if (!fs.existsSync(file)) {
                    this.logger.warn(`文件不存在: ${file}`);
                    continue;  // 跳过不存在的文件
                }

                // 步骤2：检查文件大小，避免读取超大文件导致内存问题
                const stat = await fs.promises.stat(file);
                if (stat.size > RuleEngine.MAX_FILE_SIZE_BYTES) {
                    this.logger.warn(`文件过大，已跳过: ${file} (${stat.size} bytes)`);
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

                // 步骤3：检查是否为二进制文件，避免乱码或解析异常
                const isBinary = await this.isBinaryFile(file);
                if (isBinary) {
                    this.logger.warn(`检测到二进制文件，已跳过: ${file}`);
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

                // 步骤4：读取文件内容
                // fs.promises.readFile 是 Node.js 的异步文件读取 API
                // 'utf-8' 指定以 UTF-8 编码读取文件
                const content = await fs.promises.readFile(file, 'utf-8');
                
                // 步骤5：检查文件并收集问题
                const fileIssues = await this.checkFile(file, content);
                issues.push(...fileIssues);  // 将问题添加到总列表
            } catch (error) {
                // 如果读取文件失败（权限问题、编码问题等），记录错误但继续处理其他文件
                this.logger.error(`检查文件失败: ${file}`, error);
            }
        }

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

    /**
     * 将规则的 action 转换为问题的严重程度
     * 
     * action 是配置中的行为设置：
     * - block_commit: 阻止提交，对应 error 级别
     * - warning: 仅警告，对应 warning 级别
     * - log: 仅记录，对应 info 级别
     * 
     * @param action - 规则的 action 配置
     * @returns 对应的严重程度
     */
    private getSeverity(action: 'block_commit' | 'warning' | 'log'): 'error' | 'warning' | 'info' {
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

    getRules(): Rule[] {
        return this.rules;
    }
}
