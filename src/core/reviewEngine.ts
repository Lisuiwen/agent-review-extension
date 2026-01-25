/**
 * 审查引擎
 * 
 * 这是整个插件的核心组件，负责协调各个子系统完成代码审查
 * 
 * 主要职责：
 * 1. 接收文件列表，执行代码审查
 * 2. 调用规则引擎检查代码问题
 * 3. 根据配置决定是否阻止提交
 * 4. 返回结构化的审查结果
 * 
 * 工作流程：
 * 1. 获取需要审查的文件列表（通常是 git staged 文件）
 * 2. 根据配置过滤掉排除的文件
 * 3. 调用规则引擎检查每个文件
 * 4. 将问题按严重程度分类（error/warning/info）
 * 5. 根据配置判断是否通过审查
 */

import { RuleEngine } from './ruleEngine';
import { AIReviewer } from './aiReviewer';
import { ConfigManager } from '../config/configManager';
import { Logger } from '../utils/logger';
import { FileScanner } from '../utils/fileScanner';

/**
 * 审查结果接口
 * 包含审查是否通过，以及按严重程度分类的问题列表
 */
export interface ReviewResult {
    passed: boolean;           // 审查是否通过（true=通过，false=未通过）
    errors: ReviewIssue[];     // 错误级别的问题（会阻止提交）
    warnings: ReviewIssue[];   // 警告级别的问题（不会阻止提交）
    info: ReviewIssue[];       // 信息级别的问题（仅记录）
}

/**
 * 审查问题接口
 * 描述一个具体的代码问题，包含位置、消息、规则等信息
 */
export interface ReviewIssue {
    file: string;              // 文件路径
    line: number;              // 问题所在行号（从1开始）
    column: number;            // 问题所在列号（从1开始）
    message: string;           // 问题描述消息
    rule: string;              // 触发的规则名称（如 'no_space_in_filename'）
    severity: 'error' | 'warning' | 'info';  // 严重程度
    fixable?: boolean;         // 是否可自动修复（未来功能）
}

/**
 * 审查引擎类
 * 
 * 使用方式：
 * ```typescript
 * const reviewEngine = new ReviewEngine(configManager);
 * const result = await reviewEngine.reviewStagedFiles();
 * if (!result.passed) {
 *     console.log('审查未通过，发现', result.errors.length, '个错误');
 * }
 * ```
 */
export class ReviewEngine {
    private ruleEngine: RuleEngine;
    private aiReviewer: AIReviewer;
    private configManager: ConfigManager;
    private fileScanner: FileScanner;
    private logger: Logger;

    /**
     * 构造函数
     * 初始化审查引擎及其依赖的组件
     * 
     * @param configManager - 配置管理器，用于读取审查规则配置
     */
    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
        this.logger = new Logger('ReviewEngine');
        // 规则引擎：负责执行具体的规则检查
        this.ruleEngine = new RuleEngine(configManager);
        // AI审查器：用于AI代码审查
        this.aiReviewer = new AIReviewer(configManager);
        // 文件扫描器：用于获取文件列表和读取文件内容
        this.fileScanner = new FileScanner();
    }

    /**
     * 初始化审查引擎
     * 初始化AI审查器（如果启用）
     */
    async initialize(): Promise<void> {
        const config = this.configManager.getConfig();
        if (config.ai_review?.enabled) {
            await this.aiReviewer.initialize();
        }
    }

    /**
     * 审查指定的文件列表
     * 
     * 这是核心审查方法，执行以下步骤：
     * 1. 过滤排除的文件
     * 2. 调用规则引擎检查每个文件
     * 3. 按严重程度分类问题
     * 4. 根据配置判断是否通过
     * 
     * @param files - 要审查的文件路径数组
     * @returns 审查结果对象
     */
    async review(files: string[]): Promise<ReviewResult> {
        // 强制显示日志通道，确保日志可见
        this.logger.show();
        this.logger.info(`开始审查 ${files.length} 个文件`);
        
        const result: ReviewResult = {
            passed: true,
            errors: [],
            warnings: [],
            info: []
        };

        if (files.length === 0) {
            this.logger.info('没有文件需要审查');
            return result;
        }

        // 步骤1：获取配置，过滤掉排除的文件
        // 用户可以在配置文件中指定要排除的文件或目录
        this.logger.info('获取配置信息...');
        const config = this.configManager.getConfig();
        this.logger.info(`配置加载完成: rules.enabled=${config.rules.enabled}, ai_review=${config.ai_review ? `enabled=${config.ai_review.enabled}, endpoint=${config.ai_review.api_endpoint || '未配置'}` : '未配置'}`);
        const filteredFiles = files.filter(file => {
            if (config.exclusions) {
                // shouldExclude 方法检查文件是否在排除列表中
                return !this.fileScanner.shouldExclude(file, config.exclusions);
            }
            return true;
        });

        if (filteredFiles.length === 0) {
            this.logger.info('所有文件都被排除，无需审查');
            return result;
        }

        // 步骤2：调用规则引擎检查所有文件
        // ruleEngine.checkFiles 会读取每个文件的内容，并应用所有启用的规则
        const ruleIssues = await this.ruleEngine.checkFiles(filteredFiles);
        
        // 步骤2.5：调用AI审查（如果启用）
        let aiIssues: ReviewIssue[] = [];
        // 检查AI审查配置
        if (config.ai_review) {
            this.logger.info(`AI审查配置存在: enabled=${config.ai_review.enabled}, endpoint=${config.ai_review.api_endpoint || '未配置'}`);
            if (config.ai_review.enabled) {
                try {
                    // 准备AI审查请求
                    // 注意：不传content字段，让AIReviewer自动读取文件内容
                    // 这样可以避免传递空字符串导致的问题
                    const aiRequest = {
                        files: filteredFiles.map(file => ({ path: file }))
                    };
                    
                    this.logger.info(`开始调用AI审查，文件数量: ${aiRequest.files.length}`);
                    // 调用AI审查
                    aiIssues = await this.aiReviewer.review(aiRequest);
                    this.logger.info(`AI审查完成: 发现 ${aiIssues.length} 个问题`);
                } catch (error) {
                    // AI审查失败，记录错误但不阻塞审查流程
                    this.logger.error('AI审查失败', error);
                    // 如果配置为block_commit，AI审查失败应该阻止提交
                    if (config.ai_review.action === 'block_commit') {
                        result.errors.push({
                            file: '',
                            line: 1,
                            column: 1,
                            message: `AI审查失败: ${error instanceof Error ? error.message : String(error)}`,
                            rule: 'ai_review_error',
                            severity: 'error'
                        });
                    }
                }
            } else {
                this.logger.info('AI审查已配置但未启用（enabled=false）');
            }
        } else {
            this.logger.info('AI审查未配置（config.ai_review 不存在）');
        }
        
        // 步骤3：合并规则引擎和AI审查的结果，并按严重程度分类
        const allIssues = [...ruleIssues, ...aiIssues];
        for (const issue of allIssues) {
            switch (issue.severity) {
                case 'error':
                    result.errors.push(issue);  // 错误：会阻止提交
                    break;
                case 'warning':
                    result.warnings.push(issue);  // 警告：不会阻止提交
                    break;
                case 'info':
                    result.info.push(issue);  // 信息：仅记录
                    break;
            }
        }

        // 步骤4：根据配置决定是否通过审查
        // 判断逻辑：
        // - 如果 strict_mode 开启：任何错误都会导致不通过
        // - 否则：只有 action 为 'block_commit' 的错误才会导致不通过
        const configRules = config.rules;
        const hasBlockingErrors = result.errors.some(error => {
            // 检查对应的规则配置是否为 block_commit
            // 只有配置为 block_commit 的错误才会真正阻止提交
            
            // AI审查的错误
            if (error.rule === 'ai_review' || error.rule === 'ai_review_error') {
                return config.ai_review?.action === 'block_commit';
            }
            
            // 规则引擎的错误
            if (error.rule === 'no_space_in_filename') {
                return configRules.naming_convention?.action === 'block_commit';
            }
            if (error.rule === 'no_todo') {
                return configRules.code_quality?.action === 'block_commit';
            }
            return false;
        });

        // 设置审查结果
        // strict_mode: 严格模式，所有错误都阻止提交
        // 否则：只有 block_commit 的错误才阻止提交
        if (configRules.strict_mode) {
            result.passed = result.errors.length === 0;
        } else {
            result.passed = !hasBlockingErrors;
        }

        this.logger.info(`审查完成: ${result.errors.length}个错误, ${result.warnings.length}个警告, ${result.info.length}个信息`);
        
        return result;
    }

    /**
     * 审查 Git staged 文件
     * 
     * 这是最常用的审查方法，会自动获取所有已暂存（staged）的文件
     * 通常在以下场景调用：
     * - 用户手动触发审查命令
     * - Git pre-commit hook 执行时
     * 
     * @returns 审查结果对象
     */
    async reviewStagedFiles(): Promise<ReviewResult> {
        // 强制显示日志通道，确保日志可见
        this.logger.show();
        this.logger.info('审查staged文件');
        
        // 获取所有 staged 文件
        // getStagedFiles 内部使用 'git diff --cached --name-only' 命令
        this.logger.info('正在获取staged文件列表...');
        const stagedFiles = await this.fileScanner.getStagedFiles();
        this.logger.info(`获取到 ${stagedFiles.length} 个staged文件`);
        
        // 如果没有 staged 文件，直接返回通过
        if (stagedFiles.length === 0) {
            this.logger.info('没有staged文件需要审查，跳过审查');
            return {
                passed: true,
                errors: [],
                warnings: [],
                info: []
            };
        }

        this.logger.info(`找到 ${stagedFiles.length} 个staged文件，开始审查: ${stagedFiles.slice(0, 3).join(', ')}${stagedFiles.length > 3 ? '...' : ''}`);
        
        // 调用 review 方法审查这些文件
        this.logger.info('调用 review() 方法开始审查');
        return this.review(stagedFiles);
    }
}
