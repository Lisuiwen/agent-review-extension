/**
 * AI 审查相关类型、Zod Schema、常量与校验工具
 *
 * 供 aiReviewer 主文件及各子模块（snippets、batching、prompts、responseParser、transform、issueFilter）引用。
 * 子模块仅依赖本文件与 types，不互相引用。
 */

import { z } from 'zod';
import type { Logger } from '../utils/logger';

/** AI审查配置：从 AgentReviewConfig 中提取的 AI 相关字段 */
export interface AIReviewConfig {
    enabled: boolean;
    api_format?: 'openai' | 'custom';
    apiEndpoint: string;
    apiKey?: string;
    model?: string;
    timeout: number;
    temperature?: number;
    max_tokens?: number;
    system_prompt?: string;
    retry_count?: number;
    retry_delay?: number;
    diff_only?: boolean;
    batching_mode?: 'file_count' | 'ast_snippet';
    ast_snippet_budget?: number;
    ast_chunk_strategy?: 'even' | 'contiguous';
    batch_concurrency?: number;
    max_request_chars?: number;
    run_on_save?: boolean;
    funnel_lint?: boolean;
    funnel_lint_severity?: 'error' | 'warning';
    ignore_format_only_diff?: boolean;
    ignore_comment_only_diff?: boolean;
    action: 'block_commit' | 'warning' | 'log';
}

/** 请求 Schema：files 列表，每项 path 必填、content 可选 */
export const AIReviewRequestSchema = z.object({
    files: z.array(
        z.object({
            path: z.string().min(1, '文件路径不能为空'),
            content: z.string().optional()
        })
    ).min(1, '至少需要一个文件')
});

/** 响应 Schema：issues 数组，每项含 file/line/column/snippet/message/severity */
export const AIReviewResponseSchema = z.object({
    issues: z.array(
        z.object({
            file: z.string().min(1, '文件路径不能为空'),
            line: z.number().int().positive('行号必须是正整数').default(1),
            column: z.number().int().nonnegative('列号必须是非负整数').default(1),
            snippet: z.string().optional(),
            message: z.string().min(1, '问题描述不能为空'),
            severity: z.enum(['error', 'warning', 'info'], {
                message: '严重程度必须是 error、warning 或 info 之一'
            })
        })
    )
});

/** OpenAI 兼容响应 Schema：choices[0].message.content */
export const OpenAIResponseSchema = z.object({
    choices: z.array(
        z.object({
            message: z.object({
                content: z.string().min(1, '响应内容不能为空')
            })
        })
    ).min(1, '响应中必须包含至少一个 choice')
});

export type AIReviewRequest = z.infer<typeof AIReviewRequestSchema>;
export type AIReviewResponse = z.infer<typeof AIReviewResponseSchema>;

/** 审查单元来源：ast=AST 片段，diff=diff 片段，full=整文件 */
export type ReviewUnitSourceType = 'ast' | 'diff' | 'full';

/** 单次发给 AI 的审查单元（一文件、或多 AST 块、或按 snippet 预算拆分的子集） */
export interface ReviewUnit {
    unitId: string;
    path: string;
    content: string;
    snippetCount: number;
    sourceType: ReviewUnitSourceType;
}

/** 默认超时（毫秒） */
export const DEFAULT_TIMEOUT = 30000;
/** 重试基础延迟（毫秒） */
export const DEFAULT_RETRY_DELAY = 1000;
/** 最大重试次数 */
export const DEFAULT_MAX_RETRIES = 3;
/** 默认 temperature */
export const DEFAULT_TEMPERATURE = 0.7;
/** 默认 max_tokens */
export const DEFAULT_MAX_TOKENS = 8000;
/** 按文件数切批时的默认批次大小 */
export const DEFAULT_BATCH_SIZE = 5;
/** 默认 batching_mode */
export const DEFAULT_BATCHING_MODE: NonNullable<AIReviewConfig['batching_mode']> = 'file_count';
/** 默认 ast_snippet_budget */
export const DEFAULT_AST_SNIPPET_BUDGET = 25;
/** 默认 ast_chunk_strategy */
export const DEFAULT_AST_CHUNK_STRATEGY: NonNullable<AIReviewConfig['ast_chunk_strategy']> = 'even';
/** 默认批处理并发数 */
export const DEFAULT_BATCH_CONCURRENCY = 2;
/** 单次请求最大字符数（超长时二分批次） */
export const DEFAULT_MAX_REQUEST_CHARS = 50000;

/** 默认系统提示词（代码审查专家） */
export const DEFAULT_SYSTEM_PROMPT = `你是一个经验丰富的代码审查专家。你的任务是深入分析代码，找出所有潜在问题，并提供详细的改进建议。

审查时请关注以下方面：
1. **Bug和运行时错误**：未定义的变量、空指针、类型错误、逻辑错误等
2. **性能问题**：低效的算法、不必要的循环、内存泄漏、资源未释放等
3. **安全问题**：SQL注入、XSS、CSRF、敏感信息泄露、不安全的API调用等
4. **代码质量**：可读性、可维护性、代码重复、命名规范、注释缺失等
5. **最佳实践**：设计模式、错误处理、边界条件、异常情况处理等
6. **潜在问题**：即使代码能运行，也要指出可能在未来导致问题的代码模式

请提供详细、具体、可操作的建议。即使代码看起来没有严重问题，也要提供改进建议和最佳实践。`;

/** 格式化 Zod 错误为可读字符串 */
export function formatZodError(error: z.ZodError): string {
    return error.issues.map((issue: z.ZodIssue) =>
        `${issue.path.join('.')}: ${issue.message}`
    ).join(', ');
}

/** 统一处理 Zod 校验错误：ZodError 时打日志并抛格式化错误，否则原样抛出 */
export function handleZodError(error: unknown, logger: Logger, context: string): never {
    if (error instanceof z.ZodError) {
        const errorDetails = formatZodError(error);
        logger.error(`${context}格式验证失败`, { issues: error.issues });
        throw new Error(`${context}格式验证失败: ${errorDetails}`);
    }
    throw error;
}
