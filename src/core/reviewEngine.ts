import { RuleEngine } from './ruleEngine';
import { AIReviewer } from './aiReviewer';
import { ConfigManager } from '../config/configManager';
import { Logger } from '../utils/logger';

export interface ReviewResult {
    passed: boolean;
    errors: ReviewIssue[];
    warnings: ReviewIssue[];
    info: ReviewIssue[];
}

export interface ReviewIssue {
    file: string;
    line: number;
    column: number;
    message: string;
    rule: string;
    severity: 'error' | 'warning' | 'info';
    fixable?: boolean;
}

export class ReviewEngine {
    private ruleEngine: RuleEngine;
    private aiReviewer: AIReviewer;
    private configManager: ConfigManager;
    private logger: Logger;

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
        this.logger = new Logger('ReviewEngine');
        this.ruleEngine = new RuleEngine(configManager);
        this.aiReviewer = new AIReviewer(configManager);
    }

    async review(files: string[]): Promise<ReviewResult> {
        // TODO: 实现审查逻辑
        this.logger.info(`开始审查 ${files.length} 个文件`);
        
        const result: ReviewResult = {
            passed: true,
            errors: [],
            warnings: [],
            info: []
        };

        // TODO: 调用规则引擎检查
        // TODO: 调用AI审查服务
        // TODO: 聚合结果

        return result;
    }

    async reviewStagedFiles(): Promise<ReviewResult> {
        // TODO: 获取staged文件并审查
        return this.review([]);
    }
}
