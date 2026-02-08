import * as path from 'path';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { z } from 'zod';
import { ConfigManager, AgentReviewConfig } from '../config/configManager';
import { Logger } from '../utils/logger';
import type { ReviewIssue } from '../types/review';
import { FileScanner } from '../utils/fileScanner';
import type { FileDiff } from '../utils/diffTypes';
import type { AffectedScopeResult } from '../utils/astScope';

/**
 * AI审查配置接口
 * 从AgentReviewConfig中提取AI相关配置
 */
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
    action: 'block_commit' | 'warning' | 'log';
}

/**
 * AI审查请求的 Zod Schema
 * 用于验证输入数据的格式和类型
 * 
 * 这个 schema 定义了发送给 AI API 的请求格式：
 * - files: 文件列表，每个文件包含路径，content可选（如果未提供会自动读取）
 */
const AIReviewRequestSchema = z.object({
    files: z.array(
        z.object({
            path: z.string().min(1, '文件路径不能为空'),
            content: z.string().optional() // content可选，如果未提供或为空，会自动读取文件
        })
    ).min(1, '至少需要一个文件')
});

/**
 * AI审查响应的 Zod Schema
 * 用于验证 AI API 返回的数据格式
 * 
 * 这个 schema 定义了 AI API 应该返回的响应格式：
 * - issues: 问题列表，每个问题包含文件路径、位置、消息和严重程度
 */
const AIReviewResponseSchema = z.object({
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

/**
 * OpenAI API 响应的 Zod Schema
 * 用于验证 OpenAI 兼容格式的 API 响应
 * 
 * OpenAI/Moonshot API 返回格式：
 * {
 *   choices: [{
 *     message: {
 *       content: "JSON字符串"
 *     }
 *   }]
 * }
 */
const OpenAIResponseSchema = z.object({
    choices: z.array(
        z.object({
            message: z.object({
                content: z.string().min(1, '响应内容不能为空')
            })
        })
    ).min(1, '响应中必须包含至少一个 choice')
});

/**
 * AI审查请求类型
 * 从 Zod Schema 自动生成的 TypeScript 类型
 */
export type AIReviewRequest = z.infer<typeof AIReviewRequestSchema>;

/**
 * AI审查响应类型
 * 从 Zod Schema 自动生成的 TypeScript 类型
 */
export type AIReviewResponse = z.infer<typeof AIReviewResponseSchema>;

/**
 * 常量定义
 */
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRY_DELAY = 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 8000; // 增加默认token限制，确保有足够空间返回详细分析
const DEFAULT_BATCH_SIZE = 5; // AI 审查默认批次大小
const DEFAULT_SYSTEM_PROMPT = `你是一个经验丰富的代码审查专家。你的任务是深入分析代码，找出所有潜在问题，并提供详细的改进建议。

审查时请关注以下方面：
1. **Bug和运行时错误**：未定义的变量、空指针、类型错误、逻辑错误等
2. **性能问题**：低效的算法、不必要的循环、内存泄漏、资源未释放等
3. **安全问题**：SQL注入、XSS、CSRF、敏感信息泄露、不安全的API调用等
4. **代码质量**：可读性、可维护性、代码重复、命名规范、注释缺失等
5. **最佳实践**：设计模式、错误处理、边界条件、异常情况处理等
6. **潜在问题**：即使代码能运行，也要指出可能在未来导致问题的代码模式

请提供详细、具体、可操作的建议。即使代码看起来没有严重问题，也要提供改进建议和最佳实践。`;

/**
 * 工具函数：格式化 Zod 错误信息
 * 
 * @param error - Zod 验证错误
 * @returns 格式化的错误消息字符串
 */
function formatZodError(error: z.ZodError): string {
    return error.issues.map((issue: z.ZodIssue) => 
        `${issue.path.join('.')}: ${issue.message}`
    ).join(', ');
}

/**
 * 工具函数：处理 Zod 验证错误
 * 
 * @param error - 可能的错误对象
 * @param logger - 日志记录器
 * @param context - 错误上下文描述
 * @throws 格式化的错误
 */
function handleZodError(error: unknown, logger: Logger, context: string): never {
    if (error instanceof z.ZodError) {
        const errorDetails = formatZodError(error);
        logger.error(`${context}格式验证失败`, { issues: error.issues });
        throw new Error(`${context}格式验证失败: ${errorDetails}`);
    }
    throw error;
}

/**
 * AI审查器类
 * 
 * 负责调用AI API进行代码审查
 * 支持OpenAI兼容格式和自定义格式
 * 
 * 使用方式：
 * ```typescript
 * const aiReviewer = new AIReviewer(configManager);
 * await aiReviewer.initialize();
 * const issues = await aiReviewer.review({ files: [...] });
 * ```
 */
export class AIReviewer {
    private configManager: ConfigManager;
    private logger: Logger;
    private fileScanner: FileScanner;
    private config: AIReviewConfig | null = null;
    private axiosInstance: AxiosInstance;
    private responseCache = new Map<string, { response: AIReviewResponse; isPartial: boolean }>();
    private baseMessageCache = new Map<string, Array<{ role: string; content: string }>>();

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
        this.logger = new Logger('AIReviewer');
        this.fileScanner = new FileScanner();
        
        // 创建axios实例，统一配置
        // Moonshot API 使用 OpenAI 兼容格式，认证方式也是 Bearer Token
        this.axiosInstance = axios.create({
            timeout: DEFAULT_TIMEOUT,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // 请求拦截器：添加认证信息
        // Moonshot API 使用 Bearer Token 认证，格式：Authorization: Bearer <api_key>
        this.axiosInstance.interceptors.request.use(
            (config) => {
                if (this.config?.apiKey) {
                    // Moonshot API 使用标准的 Bearer Token 认证
                    // 参考：https://platform.moonshot.cn/docs/guide/start-using-kimi-api
                    config.headers.Authorization = `Bearer ${this.config.apiKey}`;
                }
                return config;
            },
            (error) => Promise.reject(error)
        );
        
        // 响应拦截器：统一错误处理
        this.axiosInstance.interceptors.response.use(
            (response) => response,
            (error: AxiosError) => {
                this.logger.error(`AI API调用失败: ${error.message}`);
                if (error.response?.status === 404) {
                    const body = error.response?.data as { error?: { message?: string; type?: string } } | undefined;
                    const msg = body?.error?.message ?? '';
                    this.logger.warn(`404 可能原因：① 模型不存在或无权限（厂商文档：404 = 不存在该 model 或 Permission denied）② 端点地址错误。当前使用 model 见上方日志。响应: ${msg || JSON.stringify(body ?? '')}`);
                }
                return Promise.reject(error);
            }
        );
    }

    /**
     * 初始化AI审查器
     * 从ConfigManager加载AI审查配置
     */
    async initialize(): Promise<void> {
        this.logger.info('AI审查服务初始化');
        
        const config = this.configManager.getConfig();
        if (!config.ai_review) {
            this.logger.info('AI审查未配置（config.ai_review 不存在）');
            this.config = null;
            return;
        }

        // 转换配置格式；OpenAI 兼容格式下若只填了 base URL（如 https://api.moonshot.cn/v1），自动补全 /chat/completions，与官方文档一致
        const rawEndpoint = (config.ai_review.api_endpoint || '').trim().replace(/\/+$/, '');
        const apiEndpoint =
            config.ai_review.api_format === 'custom'
                ? rawEndpoint
                : rawEndpoint && !rawEndpoint.endsWith('/chat/completions')
                    ? `${rawEndpoint}/chat/completions`
                    : rawEndpoint;
        this.config = {
            enabled: config.ai_review.enabled,
            api_format: config.ai_review.api_format || 'openai',
            apiEndpoint,
            apiKey: config.ai_review.api_key,
            model: config.ai_review.model ?? '',
            timeout: config.ai_review.timeout || DEFAULT_TIMEOUT,
            temperature: config.ai_review.temperature ?? DEFAULT_TEMPERATURE,
            max_tokens: config.ai_review.max_tokens || DEFAULT_MAX_TOKENS,
            system_prompt: config.ai_review.system_prompt || DEFAULT_SYSTEM_PROMPT,
            retry_count: config.ai_review.retry_count ?? DEFAULT_MAX_RETRIES,
            retry_delay: config.ai_review.retry_delay || DEFAULT_RETRY_DELAY,
            diff_only: config.ai_review.diff_only ?? true,
            action: config.ai_review.action
        };

        // 更新axios实例的超时时间
        this.axiosInstance.defaults.timeout = this.config.timeout;

        const ep = this.config.apiEndpoint || '';
        const endpointResolved = !!ep && !ep.includes('${');
        this.logger.info(`AI审查服务已初始化: enabled=${this.config.enabled}, format=${this.config.api_format}, model=${this.config.model || '未配置'}`);
        if (ep) {
            if (endpointResolved) {
                this.logger.info(`[端点已解析] 当前 API 地址: ${ep}`);
            } else {
                this.logger.warn(`[端点未解析] 仍含占位符，请检查 .env 或设置中的环境变量: ${ep.substring(0, 60)}${ep.length > 60 ? '...' : ''}`);
            }
        }
        // 检查关键配置
        if (!ep) {
            this.logger.warn('⚠️ AI API端点未配置，AI审查将无法执行');
        }
        // 检查 apiKey 是否配置且已正确解析（不是环境变量占位符）
        if (!this.config.apiKey) {
            this.logger.warn('⚠️ AI API密钥未配置，可能导致认证失败');
        } else if (this.config.apiKey.startsWith('${') && this.config.apiKey.endsWith('}')) {
            this.logger.warn(`⚠️ AI API密钥环境变量未解析: ${this.config.apiKey}`);
            this.logger.warn('请确保设置了 OPENAI_API_KEY 环境变量，或在项目根目录创建 .env 文件');
        } else {
            this.logger.info(`✓ AI API密钥已配置（长度: ${this.config.apiKey.length}）`);
        }
    }

    /**
     * 执行AI审查
     *
     * 当 request.diffByFile 存在且配置 diff_only 启用时，仅发送变更片段；
     * 当 request.astSnippetsByFile 存在时，优先发送 AST 片段。返回的 line 均为新文件行号。
     *
     * @param request - 审查请求；可含 diffByFile 用于增量审查
     * @returns 审查问题列表
     */
    async review(
        request: AIReviewRequest & {
            diffByFile?: Map<string, FileDiff>;
            astSnippetsByFile?: Map<string, AffectedScopeResult>;
        }
    ): Promise<ReviewIssue[]> {
        const validatedRequest = this.validateRequest(request);
        const diffByFile = request.diffByFile;
        const astSnippetsByFile = request.astSnippetsByFile;
        this.logger.info(`AI审查 ${validatedRequest.files.length} 个文件`);

        await this.ensureInitialized();
        if (!this.isConfigValid()) {
            return [];
        }

        this.resetReviewCache();

        const useDiffMode = this.config?.diff_only !== false && diffByFile && diffByFile.size > 0;
        const useAstSnippets = !!astSnippetsByFile && astSnippetsByFile.size > 0;
        const useDiffContent = useDiffMode || useAstSnippets;
        const filesToLoad = useDiffContent
            ? validatedRequest.files.map(f => {
                const normalizedPath = path.normalize(f.path);
                let content: string | undefined;
                if (useAstSnippets) {
                    const astSnippets = astSnippetsByFile!.get(normalizedPath) ?? astSnippetsByFile!.get(f.path);
                    if (astSnippets?.snippets?.length) {
                        content = this.buildAstSnippetForFile(f.path, astSnippets);
                    }
                }
                if (!content && useDiffMode) {
                    const fileDiff = diffByFile!.get(normalizedPath) ?? diffByFile!.get(f.path);
                    content = fileDiff?.hunks?.length
                        ? this.buildDiffSnippetForFile(f.path, fileDiff)
                        : undefined;
                    if (!content) {
                        this.logger.warn(`[diff_only] 文件 ${f.path} 未取得变更片段(hasFileDiff=${!!fileDiff}, hunksLength=${fileDiff?.hunks?.length ?? 0})，将改为发送整文件`);
                    }
                }
                if (!content && useAstSnippets) {
                    this.logger.warn(`[ast_only] 文件 ${f.path} 未取得 AST 片段，将改为发送整文件`);
                }
                return { path: f.path, content };
            })
            : validatedRequest.files;

        // diff/AST 模式下：仅保留「变更相关行」上的 AI 问题，过滤掉模型对未发送行的推断
        const allowedLinesByFile = new Map<string, Set<number>>();
        const addAllowedLine = (filePath: string, line: number): void => {
            const normalizedPath = path.normalize(filePath);
            const existing = allowedLinesByFile.get(normalizedPath) ?? new Set<number>();
            existing.add(line);
            allowedLinesByFile.set(normalizedPath, existing);
        };
        if (useAstSnippets && astSnippetsByFile) {
            for (const [filePath, result] of astSnippetsByFile) {
                for (const snippet of result.snippets) {
                    for (let line = snippet.startLine; line <= snippet.endLine; line++) {
                        addAllowedLine(filePath, line);
                    }
                }
            }
        }
        if (useDiffMode && diffByFile) {
            for (const [filePath, fileDiff] of diffByFile) {
                for (const hunk of fileDiff.hunks) {
                    for (let r = 0; r < hunk.newCount; r++) {
                        addAllowedLine(filePath, hunk.newStart + r);
                    }
                }
            }
        }

        try {
            const astConfig = this.configManager.getConfig().ast;
            const previewOnly = astConfig?.preview_only === true;
            if (previewOnly) {
                this.logger.info('[ast.preview_only=true] 仅预览切片，不请求大模型');
            }
            const validFiles = await this.loadFilesWithContent(filesToLoad, previewOnly);
            if (validFiles.length === 0) {
                this.logger.warn('没有可审查的文件');
                return [];
            }

            if (previewOnly) {
                this.logger.info('[preview_only] 不调用大模型，仅打印最终合并后的切片内容');
                for (const file of validFiles) {
                    this.logger.info(`---------- ${file.path} ----------`);
                    this.logger.info(file.content);
                    this.logger.info('----------');
                }
                return [];
            }

            const batches = this.splitIntoBatches(validFiles, DEFAULT_BATCH_SIZE);
            const processedFiles = new Set<string>();
            const allIssues: ReviewIssue[] = [];

            for (let i = 0; i < batches.length; i++) {
                const batchIndex = i + 1;
                const batch = batches[i];
                const batchFiles = batch.filter(file => {
                    if (processedFiles.has(file.path)) {
                        this.logger.warn(`批处理重复文件已跳过: ${file.path}`);
                        return false;
                    }
                    processedFiles.add(file.path);
                    return true;
                });

                if (batchFiles.length === 0) {
                    this.logger.warn(`批次 ${batchIndex}/${batches.length} 没有可审查文件，已跳过`);
                    continue;
                }

                this.logger.info(`AI审查批次 ${batchIndex}/${batches.length}: ${batchFiles.length} 个文件`);

                try {
                    const response = await this.callAPI(
                        { files: batchFiles },
                        { isDiffContent: useDiffContent }
                    );
                    let batchIssues = this.transformToReviewIssues(
                        response,
                        batchFiles,
                        { useDiffLineNumbers: useDiffContent }
                    );
                    if (useDiffContent && allowedLinesByFile.size > 0) {
                        const before = batchIssues.length;
                        batchIssues = batchIssues.filter(issue => {
                            const allowed = allowedLinesByFile.get(path.normalize(issue.file));
                            if (!allowed) return false;
                            return allowed.has(issue.line);
                        });
                        if (before > batchIssues.length) {
                            this.logger.info(`[diff_only] 已过滤掉 ${before - batchIssues.length} 条非变更行上的 AI 问题，保留 ${batchIssues.length} 条`);
                        }
                    }
                    allIssues.push(...batchIssues);
                } catch (error) {
                    const handledIssues = this.handleReviewError(error);
                    allIssues.push(...handledIssues);
                }
            }

            return allIssues;
        } catch (error) {
            return this.handleReviewError(error);
        }
    }

    /**
     * 验证输入请求
     * 
     * @param request - 待验证的请求
     * @returns 验证后的请求
     * @throws 如果验证失败
     */
    private validateRequest(request: AIReviewRequest): AIReviewRequest {
        try {
            return AIReviewRequestSchema.parse(request);
        } catch (error) {
            handleZodError(error, this.logger, 'AI审查请求');
        }
    }

    /**
     * 确保配置已初始化
     * 每次审查前重新加载配置，以便读取最新的 .env 和 VSCode 设置
     */
    private async ensureInitialized(): Promise<void> {
        await this.configManager.loadConfig();
        await this.initialize();
    }

    /**
     * 检查配置是否有效
     * 
     * @returns 如果配置有效返回 true，否则返回 false
     */
    private isConfigValid(): boolean {
        if (!this.config) {
            this.logger.warn('AI审查配置不存在，跳过AI审查');
            return false;
        }
        
        if (!this.config.enabled) {
            this.logger.info('AI审查未启用');
            return false;
        }

        const ep = (this.config.apiEndpoint || '').trim();
        if (!ep || ep.includes('${')) {
            this.logger.warn(ep.includes('${') ? 'AI API端点环境变量未解析，请检查 .env 或系统环境变量' : 'AI API端点未配置');
            return false;
        }
        try {
            new URL(ep);
        } catch {
            this.logger.warn('AI API端点URL格式无效');
            return false;
        }
        const model = (this.config.model || '').trim();
        if (!model || model.includes('${')) {
            this.logger.warn(model.includes('${') ? 'AI 模型环境变量未解析' : 'AI 模型未配置，请在设置或 .env 中配置 model');
            return false;
        }
        this.validateApiKey();
        this.logger.info(`AI审查配置检查通过: endpoint=${ep}, model=${model}, hasApiKey=${this.hasValidApiKey()}`);
        return true;
    }

    /**
     * 验证 API 密钥
     */
    private validateApiKey(): void {
        const { apiKey } = this.config!;
        const normalizedKey = apiKey?.trim() || '';
        const isUnresolved = normalizedKey === '${OPENAI_API_KEY}' || normalizedKey.startsWith('${') || normalizedKey.includes('}');
        if (!normalizedKey || isUnresolved) {
            this.logger.warn('AI API密钥未配置或环境变量未解析');
            this.logger.warn('请确保设置了 OPENAI_API_KEY 环境变量，或在 .env 文件中配置');
            return;
        }
        if (normalizedKey.length < 8) {
            this.logger.warn('AI API密钥长度过短，可能无效');
        }
    }

    /**
     * 检查是否有有效的 API 密钥
     */
    private hasValidApiKey(): boolean {
        const { apiKey } = this.config!;
        const normalizedKey = apiKey?.trim() || '';
        return !!normalizedKey &&
            !normalizedKey.startsWith('${') &&
            !normalizedKey.includes('}') &&
            normalizedKey.length >= 8;
    }

    /**
     * 根据 FileDiff 构建带行号标注的变更片段，供 AI 审查使用
     * 返回格式含 "# 行 N"，便于 AI 返回正确的新文件行号
     */
    private buildDiffSnippetForFile(filePath: string, fileDiff: FileDiff): string {
        const lines: string[] = [`文件: ${filePath}`, '以下为变更片段，行号为新文件中的行号。', ''];
        for (const hunk of fileDiff.hunks) {
            for (let i = 0; i < hunk.lines.length; i++) {
                const lineNum = hunk.newStart + i;
                lines.push(`# 行 ${lineNum}`);
                lines.push(hunk.lines[i]);
            }
            lines.push('');
        }
        return lines.join('\n');
    }

    /**
     * 根据 AST 片段构建带行号标注的内容，供 AI 审查使用
     */
    private buildAstSnippetForFile(filePath: string, result: AffectedScopeResult): string {
        const lines: string[] = [`文件: ${filePath}`, '以下为变更相关的 AST 片段，行号为新文件中的行号。', ''];
        for (const snippet of result.snippets) {
            lines.push(`# 行 ${snippet.startLine}`);
            lines.push(snippet.source);
            lines.push('');
        }
        return lines.join('\n');
    }

    /**
     * 加载文件内容
     *
     * @param files - 文件列表（可能只有路径或已带 content 的 diff 片段）
     * @returns 包含内容的文件列表
     */
    private async loadFilesWithContent(
        files: Array<{ path: string; content?: string }>,
        previewOnly = false
    ): Promise<Array<{ path: string; content: string }>> {
        const filesWithContent = await Promise.all(
            files.map(async (file) => {
                // 如果文件已有内容且不为空，直接使用（diff/AST 模式下为变更片段）
                // 注意：如果 content 是空字符串，也需要读取文件
                if (file.content !== undefined && file.content.trim().length > 0) {
                    if (!previewOnly) {
                        const isDiffSnippet = file.content.includes('以下为变更片段，行号为新文件中的行号。');
                        const isAstSnippet = file.content.includes('以下为变更相关的 AST 片段，行号为新文件中的行号。');
                        const snippetType = isAstSnippet
                            ? 'AST片段'
                            : isDiffSnippet
                                ? '变更片段'
                                : '已提供内容';
                        this.logger.info(`[发给AI] ${file.path}: ${snippetType}, ${file.content.length} 字符`);
                    }
                    this.logger.debug(`使用已提供的文件内容: ${file.path} (长度: ${file.content.length})`);
                    return { path: file.path, content: file.content };
                }
                // 否则读取整文件（diff 模式下不应走到这里，若走到说明该文件未匹配到 diff）
                if (!previewOnly) {
                    this.logger.info(`[发给AI] ${file.path}: 读取整文件（未使用变更片段）`);
                }
                this.logger.debug(`读取文件内容: ${file.path}`);
                try {
                    const content = await this.fileScanner.readFile(file.path);
                    this.logger.debug(`成功读取文件: ${file.path} (长度: ${content.length})`);
                    if (content.length === 0) {
                        this.logger.warn(`文件为空: ${file.path}`);
                    }
                    return { path: file.path, content };
                } catch (error) {
                    this.logger.warn(`无法读取文件 ${file.path}，跳过`, error);
                    return null;
                }
            })
        );

        return filesWithContent.filter((f): f is { path: string; content: string } => f !== null);
    }

    /**
     * 将文件列表拆分为多个批次
     *
     * @param files - 文件列表
     * @param batchSize - 批次大小
     * @returns 批次数组
     */
    private splitIntoBatches = <T>(files: T[], batchSize: number): T[][] => {
        const batches: T[][] = [];
        for (let i = 0; i < files.length; i += batchSize) {
            batches.push(files.slice(i, i + batchSize));
        }
        return batches;
    };

    /**
     * 处理审查错误
     * 
     * @param error - 错误对象
     * @returns 空数组或抛出错误
     */
    private handleReviewError(error: unknown): ReviewIssue[] {
        this.logger.error('AI审查失败', error);
        
        const action = this.config?.action || 'warning';
        const severity = action === 'block_commit'
            ? 'error'
            : action === 'log'
                ? 'info'
                : 'warning';
        const message = error instanceof Error ? error.message : String(error);
        const isTimeout = axios.isAxiosError(error) && (
            error.code === 'ECONNABORTED' || /timeout/i.test(error.message)
        );
        const userMessage = isTimeout
            ? `AI审查超时（${this.config?.timeout || DEFAULT_TIMEOUT}ms），请稍后重试`
            : `AI审查失败: ${message}`;
        const rule = isTimeout ? 'ai_review_timeout' : 'ai_review_error';
        
        if (action === 'block_commit') {
            throw new Error(userMessage);
        }
        
        return [{
            file: '',
            line: 1,
            column: 1,
            message: userMessage,
            rule,
            severity
        }];
    }

    /**
     * 重置审查缓存
     * 
     * 只在单次审查生命周期内复用缓存，避免跨审查污染结果
     */
    private resetReviewCache = (): void => {
        this.responseCache.clear();
        this.baseMessageCache.clear();
    };

    /**
     * 调用AI API
     *
     * @param request - 审查请求（文件必须包含 content）
     * @param options - isDiffContent 为 true 时提示词中说明仅审查变更且 line 为新文件行号
     * @returns API响应
     */
    private async callAPI(
        request: { files: Array<{ path: string; content: string }> },
        options?: { isDiffContent?: boolean }
    ): Promise<AIReviewResponse> {
        if (!this.config) {
            throw new Error('AI审查配置未初始化');
        }
        const url = (this.config.apiEndpoint || '').trim();
        if (!url || url.includes('${')) {
            throw new Error('AI API端点未配置或环境变量未解析，请在 .env 中设置 AGENTREVIEW_AI_API_ENDPOINT 或在设置中填写完整 URL');
        }
        try {
            new URL(url);
        } catch {
            throw new Error(`AI API端点URL无效: ${url.substring(0, 60)}${url.length > 60 ? '...' : ''}`);
        }

        this.logger.info(`[请求前] 本次调用 URL: ${url}；若返回 404，请对照服务商文档确认是否为 Chat Completions 地址`);
        const requestHash = this.calculateRequestHash(request);

        const requestBody = this.config.api_format === 'custom'
            ? this.buildCustomRequest(request)
            : this.buildOpenAIRequest(request, options?.isDiffContent);

        const userMsgForLog = (requestBody as { messages?: Array<{ role: string; content: string }> }).messages?.find(m => m.role === 'user');
        const inputLen = userMsgForLog?.content?.length ?? 0;
        this.logger.info(`[传给大模型] 模式: ${options?.isDiffContent ? '仅变更相关片段(diff/ast)' : '整文件'}，user 消息长度: ${inputLen} 字符`,userMsgForLog?.content);

        if (this.config.api_format !== 'custom') {
            const baseMessages = (requestBody as { messages: Array<{ role: string; content: string }> }).messages;
            this.baseMessageCache.set(requestHash, baseMessages);
        }

        // 实现重试机制（指数退避）
        const maxRetries = this.config.retry_count ?? DEFAULT_MAX_RETRIES;
        const baseDelay = this.config.retry_delay ?? DEFAULT_RETRY_DELAY;
        let lastError: Error | null = null;
        let continuationRequestBody: typeof requestBody | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                this.logger.debug(`AI API调用 (尝试 ${attempt + 1}/${maxRetries + 1})`);
                
                const currentRequestBody = continuationRequestBody || requestBody;
                const response = await this.axiosInstance.post(
                    url,
                    currentRequestBody,
                    { timeout: this.config.timeout }
                );

                // 根据API格式解析响应
                if (this.config.api_format === 'custom') {
                    const parsedResponse = this.parseCustomResponse(response.data);
                    const mergedResponse = this.mergeCachedIssues(requestHash, parsedResponse, false);
                    return mergedResponse;
                }

                const parsedResult = this.parseOpenAIResponse(response.data);
                const mergedResponse = this.mergeCachedIssues(requestHash, parsedResult.response, parsedResult.isPartial);

                if (!parsedResult.isPartial) {
                    return mergedResponse;
                }

                this.logger.warn(`AI响应疑似被截断，已提取 ${mergedResponse.issues.length} 个问题，尝试续写补全`);

                if (attempt === maxRetries) {
                    this.logger.warn('续写重试次数已用尽，返回已解析的部分结果');
                    return mergedResponse;
                }

                const baseMessages = this.baseMessageCache.get(requestHash);
                if (!baseMessages) {
                    this.logger.warn('续写失败：未找到基础提示词，返回已解析的部分结果');
                    return mergedResponse;
                }

                continuationRequestBody = this.buildContinuationOpenAIRequest({
                    baseMessages,
                    partialContent: parsedResult.cleanedContent,
                    cachedIssues: mergedResponse.issues
                });
                continue;
            } catch (error) {
                lastError = error as Error;
                
                // 如果是最后一次尝试，直接抛出错误
                if (attempt === maxRetries) {
                    break;
                }

                // 判断是否应该重试
                if (this.shouldRetry(error as AxiosError)) {
                    const delay = baseDelay * Math.pow(2, attempt);
                    this.logger.warn(`AI API调用失败，${delay}ms后重试 (${attempt + 1}/${maxRetries})`);
                    await this.sleep(delay);
                } else {
                    // 不应该重试的错误（如401认证失败），直接抛出
                    throw error;
                }
            }
        }

        // 所有重试都失败，抛出最后一个错误
        throw new Error(`AI API调用失败（已重试${maxRetries}次）: ${lastError?.message || '未知错误'}`);
    }

    /**
     * 构建OpenAI兼容格式的请求（Moonshot API 兼容）
     *
     * @param request - 审查请求（文件必须包含 content）
     * @param isDiffContent - 若为 true，内容为变更相关片段，提示词中说明 line 为新文件行号
     * @returns OpenAI/Moonshot 兼容格式的请求体
     */
    private buildOpenAIRequest(
        request: { files: Array<{ path: string; content: string }> },
        isDiffContent?: boolean
    ): {
        model: string;
        messages: Array<{ role: string; content: string }>;
        temperature: number;
        max_tokens: number;
    } {
        if (!this.config) {
            throw new Error('AI审查配置未初始化');
        }

        const filesContent = request.files.map(file => {
            const ext = file.path.split('.').pop() || '';
            const language = this.getLanguageFromExtension(ext);
            const content = file.content;
            const contentLength = content.length;
            this.logger.debug(`构建请求 - 文件: ${file.path}, 内容长度: ${contentLength} 字符`);
            if (contentLength === 0) {
                this.logger.warn(`警告: 文件内容为空: ${file.path}`);
            } else if (contentLength < 100) {
                this.logger.debug(`文件内容预览 (前${Math.min(100, contentLength)}字符): ${content.substring(0, 100)}`);
            }
            return `文件: ${file.path}\n\`\`\`${language}\n${content}\n\`\`\``;
        }).join('\n\n');

        const totalContentLength = filesContent.length;
        this.logger.debug(`构建的提示词总长度: ${totalContentLength} 字符`);

        const intro = isDiffContent
            ? '请仅针对以下**变更相关片段（diff/AST）**进行代码审查（非整文件）。片段中已用「# 行 N」标注新文件行号。'
            : '请仔细审查以下代码文件，进行全面的代码审查分析。';
        const lineHint = isDiffContent
            ? '返回的 **line** 必须使用上述「# 行 N」中标注的新文件行号（从 1 开始）。'
            : '';

        const userPrompt = `${intro}

${filesContent}

**审查要求：**
1. 逐行分析代码，查找所有潜在问题
2. 检查bug、性能问题、安全问题、代码质量问题
3. 即使代码能正常运行，也要提供改进建议和最佳实践
4. 对于每个问题，提供详细的问题描述和具体的修复建议
5. 返回 snippet 字段（问题所在的原始代码片段，1-3行，必须来自原文件，保持原样）
6. 确保问题描述清晰、具体，包含：
   - 问题是什么
   - 为什么这是问题
   - 如何修复（提供具体的代码建议）
${lineHint ? `\n**行号说明：**\n${lineHint}\n` : ''}

**重要提示：**
- 请务必返回**完整的、格式正确的JSON**，确保JSON字符串以闭合的大括号 } 结尾
- 如果发现的问题很多，请优先返回最重要的错误和警告，确保JSON完整
- 问题描述要简洁但具体，避免过于冗长导致JSON被截断
- 请务必进行深入分析，不要只返回空数组。即使代码看起来没有问题，也要提供代码改进建议、最佳实践或潜在优化点

请严格按照以下JSON格式返回审查结果（只返回JSON，不要包含其他文字说明）：
{
  "issues": [
    {
      "file": "文件路径（完整路径）",
      "line": 行号（从1开始）,
      "column": 列号（从1开始）,
      "snippet": "问题所在的原始代码片段（1-3行，保持原样）",
      "message": "详细的问题描述和修复建议（要具体、可操作，但保持简洁）",
      "severity": "error|warning|info"
    }
  ]
}

**严重程度说明：**
- **error**：会导致运行时错误、功能失效、安全漏洞的严重问题（如：未定义变量、空指针、SQL注入等）
- **warning**：可能导致问题但不影响基本功能（如：性能问题、潜在的bug、不安全的实践等）
- **info**：代码改进建议、最佳实践、可读性改进、代码风格优化等

**最后提醒：** 请确保返回的JSON格式正确、完整，以闭合的大括号 } 结尾，并且issues数组包含所有发现的问题和改进建议。`;

        // Moonshot API 请求格式（OpenAI 兼容）
        return {
            model: this.config.model || '',
            messages: [
                {
                    role: 'system',
                    content: this.config.system_prompt || DEFAULT_SYSTEM_PROMPT
                },
                {
                    role: 'user',
                    content: userPrompt
                }
            ],
            temperature: this.config.temperature ?? DEFAULT_TEMPERATURE,
            max_tokens: this.config.max_tokens || DEFAULT_MAX_TOKENS
        };
    }

    /**
     * 构建续写请求
     * 
     * 通过保留原始提示词和已截断的响应，要求模型继续输出剩余issues
     */
    private buildContinuationOpenAIRequest = (params: {
        baseMessages: Array<{ role: string; content: string }>;
        partialContent: string;
        cachedIssues: AIReviewResponse['issues'];
    }): {
        model: string;
        messages: Array<{ role: string; content: string }>;
        temperature: number;
        max_tokens: number;
    } => {
        if (!this.config) {
            throw new Error('AI审查配置未初始化');
        }

        const lastIssue = params.cachedIssues[params.cachedIssues.length - 1];
        const lastIssueHint = lastIssue
            ? `最后一个问题: file=${lastIssue.file}, line=${lastIssue.line}, message=${lastIssue.message}`
            : '尚无完整问题被解析';

        const continuationPrompt = `上一次响应被截断，请继续输出剩余的issues。

已解析问题数量: ${params.cachedIssues.length}
${lastIssueHint}

**续写要求：**
1. 只返回新增问题，避免重复之前已输出的问题
2. 仍然严格返回完整JSON格式（只包含issues数组）
3. 如果没有更多问题，请返回 {"issues": []}
`;

        return {
            model: this.config.model || '',
            messages: [
                ...params.baseMessages,
                {
                    role: 'assistant',
                    content: params.partialContent
                },
                {
                    role: 'user',
                    content: continuationPrompt
                }
            ],
            temperature: this.config.temperature ?? DEFAULT_TEMPERATURE,
            max_tokens: this.config.max_tokens || DEFAULT_MAX_TOKENS
        };
    };

    /**
     * 生成请求哈希，用于缓存与续写关联
     * 
     * 通过文件路径与内容生成稳定哈希，确保同批次请求可复用缓存
     */
    private calculateRequestHash = (request: { files: Array<{ path: string; content: string }> }): string => {
        const raw = request.files
            .map(file => `${file.path}:${file.content}`)
            .join('|');
        return this.simpleHash(raw);
    };

    /**
     * 简单字符串哈希
     * 
     * 避免引入额外依赖，满足缓存键的稳定性需求
     */
    private simpleHash = (input: string): string => {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            hash = (hash << 5) - hash + input.charCodeAt(i);
            hash |= 0;
        }
        return `${hash}`;
    };

    /**
     * 合并并去重缓存问题
     * 
     * 用于续写场景，将已解析的问题与续写结果合并
     */
    private mergeCachedIssues = (requestHash: string, response: AIReviewResponse, isPartial: boolean): AIReviewResponse => {
        const existing = this.responseCache.get(requestHash);
        const mergedIssues = existing
            ? this.dedupeIssues([...existing.response.issues, ...response.issues])
            : this.dedupeIssues(response.issues);
        const mergedResponse = { issues: mergedIssues };
        this.responseCache.set(requestHash, {
            response: mergedResponse,
            isPartial
        });
        return mergedResponse;
    };

    /**
     * 去重 issues，避免续写带来的重复结果
     */
    private dedupeIssues = (issues: AIReviewResponse['issues']): AIReviewResponse['issues'] => {
        const seen = new Set<string>();
        return issues.filter(issue => {
            const key = `${issue.file}|${issue.line}|${issue.column}|${issue.message}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    };

    /**
     * 根据文件扩展名获取编程语言名称
     * 用于代码块的语言标识
     * 
     * @param ext - 文件扩展名
     * @returns 语言名称
     */
    private getLanguageFromExtension(ext: string): string {
        const languageMap: { [key: string]: string } = {
            'js': 'javascript',
            'ts': 'typescript',
            'jsx': 'javascript',
            'tsx': 'typescript',
            'py': 'python',
            'java': 'java',
            'cpp': 'cpp',
            'c': 'c',
            'cs': 'csharp',
            'go': 'go',
            'rs': 'rust',
            'php': 'php',
            'rb': 'ruby',
            'swift': 'swift',
            'kt': 'kotlin',
            'scala': 'scala',
            'sh': 'bash',
            'yaml': 'yaml',
            'yml': 'yaml',
            'json': 'json',
            'xml': 'xml',
            'html': 'html',
            'css': 'css',
            'scss': 'scss',
            'vue': 'vue',
            'sql': 'sql'
        };
        return languageMap[ext.toLowerCase()] || ext.toLowerCase();
    }

    /**
     * 构建自定义格式的请求
     * 
     * @param request - 审查请求（文件必须包含content）
     * @returns 自定义格式的请求体
     */
    private buildCustomRequest(request: { files: Array<{ path: string; content: string }> }): { files: Array<{ path: string; content: string }> } {
        return {
            files: request.files.map(({ path, content }) => ({ path, content }))
        };
    }

    /**
     * 解析OpenAI格式的响应
     * 
     * 使用 Zod Schema 验证和解析 AI API 返回的数据，确保数据格式正确
     * 
     * @param responseData - API响应数据
     * @returns 标准化的审查响应与解析状态
     */
    private parseOpenAIResponse(responseData: unknown): {
        response: AIReviewResponse;
        isPartial: boolean;
        cleanedContent: string;
    } {
        try {
            // 验证 OpenAI API 响应格式
            const openAIResponse = OpenAIResponseSchema.parse(responseData);
            const content = openAIResponse.choices[0].message.content;

            this.logger.debug(`AI返回内容长度: ${content.length} 字符`);

            // 清理内容并提取 JSON
            const cleanedContent = this.cleanJsonContent(content);
            
            // 检查内容是否可能被截断
            if (this.isContentTruncated(cleanedContent)) {
                this.logger.warn('检测到响应内容可能被截断（可能达到max_tokens限制）');
                this.logger.warn(`当前max_tokens设置: ${this.config?.max_tokens || DEFAULT_MAX_TOKENS}`);
                this.logger.warn('建议：1) 增加max_tokens配置值；2) 减少审查的文件数量；3) 缩短问题描述');
            }
            
            const parseResult = this.parseJsonContent(cleanedContent);

            // 验证解析后的数据
            const validatedResponse = AIReviewResponseSchema.parse(parseResult.parsed);
            
            this.logger.info(`成功解析并验证AI响应，发现 ${validatedResponse.issues.length} 个问题`);
            return {
                response: validatedResponse,
                isPartial: parseResult.isPartial,
                cleanedContent
            };
            
        } catch (error) {
            if (error instanceof z.ZodError) {
                handleZodError(error, this.logger, 'AI响应');
            }
            
            // 检查是否是截断相关的错误
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('截断') || errorMessage.includes('truncated')) {
                this.logger.error('JSON响应被截断', {
                    maxTokens: this.config?.max_tokens || DEFAULT_MAX_TOKENS,
                    suggestion: '请增加max_tokens配置值或减少审查的文件数量'
                });
            }
            
            this.logger.error('解析OpenAI响应失败', error);
            throw new Error(`解析OpenAI响应失败: ${errorMessage}`);
        }
    }

    /**
     * 清理 JSON 内容，移除 Markdown 代码块标记
     * 
     * @param content - 原始内容
     * @returns 清理后的内容
     */
    private cleanJsonContent(content: string): string {
        let cleaned = content.trim();
        
        // 如果内容被包裹在 ```json ... ``` 或 ``` ... ``` 中，提取出来
        const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonBlockMatch) {
            cleaned = jsonBlockMatch[1].trim();
            this.logger.debug('从代码块中提取JSON内容');
        }
        
        return cleaned;
    }

    /**
     * 检查内容是否可能被截断
     * 
     * @param content - JSON内容
     * @returns 如果可能被截断返回 true
     */
    private isContentTruncated(content: string): boolean {
        const trimmed = content.trim();
        
        // 检查是否以未完成的JSON结构结尾
        if (trimmed.endsWith('}')) {
            // 检查大括号是否匹配
            const openBraces = (trimmed.match(/\{/g) || []).length;
            const closeBraces = (trimmed.match(/\}/g) || []).length;
            if (openBraces !== closeBraces) {
                return true;
            }
        } else {
            // 不以 } 结尾，可能被截断
            return true;
        }
        
        // 检查是否有未完成的字符串
        const lastQuoteIndex = trimmed.lastIndexOf('"');
        if (lastQuoteIndex > 0) {
            const afterLastQuote = trimmed.substring(lastQuoteIndex + 1);
            // 如果最后一个引号后面没有闭合的结构，可能被截断
            if (!afterLastQuote.match(/^\s*[,}\]]/)) {
                const openQuotes = (trimmed.match(/"/g) || []).length;
                if (openQuotes % 2 !== 0) {
                    return true; // 奇数个引号，字符串未闭合
                }
            }
        }
        
        return false;
    }

    /**
     * 解析 JSON 内容
     * 
     * @param content - JSON 字符串内容
     * @returns 解析后的对象与是否部分解析
     * @throws 如果解析失败
     */
    private parseJsonContent(content: string): { parsed: unknown; isPartial: boolean } {
        try {
            return {
                parsed: JSON.parse(content),
                isPartial: false
            };
        } catch (jsonError) {
            const errorMessage = jsonError instanceof Error ? jsonError.message : String(jsonError);
            this.logger.debug(`直接JSON解析失败: ${errorMessage}`);
            
            // 检查是否是截断错误
            if (this.isTruncatedJsonError(errorMessage, content)) {
                this.logger.warn('检测到JSON可能被截断（达到max_tokens限制），尝试提取已解析的部分');
                return {
                    parsed: this.extractPartialJson(content),
                    isPartial: true
                };
            }
            
            // 尝试提取完整的JSON对象
            const extractedJson = this.extractJsonFromText(content);
            if (!extractedJson) {
                throw new Error(`无法从响应中提取有效的JSON对象。错误: ${errorMessage}`);
            }
            
            return {
                parsed: extractedJson,
                isPartial: false
            };
        }
    }

    /**
     * 检查是否是JSON截断错误
     * 
     * @param errorMessage - JSON解析错误消息
     * @param content - JSON内容
     * @returns 如果可能是截断错误返回 true
     */
    private isTruncatedJsonError(errorMessage: string, content: string): boolean {
        // 检查常见的截断错误模式
        const truncationPatterns = [
            /unterminated string/i,
            /unexpected end of json/i,
            /unexpected end of data/i,
            /position \d+.*end/i
        ];
        
        const hasTruncationPattern = truncationPatterns.some(pattern => pattern.test(errorMessage));
        
        // 检查内容是否以未完成的JSON结构结尾
        const trimmedContent = content.trim();
        const endsWithIncomplete = 
            trimmedContent.endsWith(',') ||
            trimmedContent.endsWith('"') ||
            trimmedContent.endsWith('\\') ||
            (trimmedContent.includes('"issues"') && !trimmedContent.endsWith('}'));
        
        return hasTruncationPattern || endsWithIncomplete;
    }

    /**
     * 提取部分JSON（当JSON被截断时）
     * 
     * 尝试从截断的JSON中提取已完成的issues项
     * 
     * @param content - 可能被截断的JSON内容
     * @returns 包含已解析issues的对象
     * @throws 如果无法提取任何有效内容
     */
    private extractPartialJson(content: string): unknown {
        // 尝试找到最后一个完整的issue对象
        const issuesMatch = content.match(/"issues"\s*:\s*\[([\s\S]*)/);
        if (!issuesMatch) {
            throw new Error('JSON被截断且无法提取issues数组');
        }

        const issuesContent = issuesMatch[1];
        const issues: unknown[] = [];
        
        // 尝试提取所有完整的issue对象
        let currentPos = 0;
        let braceCount = 0;
        let inString = false;
        let escapeNext = false;
        let issueStart = -1;
        
        for (let i = 0; i < issuesContent.length; i++) {
            const char = issuesContent[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\') {
                escapeNext = true;
                continue;
            }
            
            if (char === '"' && !escapeNext) {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    if (braceCount === 0) {
                        issueStart = i;
                    }
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0 && issueStart !== -1) {
                        // 找到一个完整的issue对象
                        try {
                            const issueStr = '{' + issuesContent.substring(issueStart, i + 1);
                            const issue = JSON.parse(issueStr);
                            issues.push(issue);
                            issueStart = -1;
                        } catch (e) {
                            // 忽略解析失败的issue
                            this.logger.debug(`跳过无效的issue对象: ${e instanceof Error ? e.message : String(e)}`);
                        }
                    }
                }
            }
        }
        
        if (issues.length === 0) {
            throw new Error('JSON被截断且无法提取任何有效的issue对象');
        }
        
        this.logger.warn(`JSON被截断，成功提取了 ${issues.length} 个完整的issue对象（可能还有更多未返回）`);
        
        return { issues };
    }

    /**
     * 从文本中提取第一个完整的 JSON 对象
     * 
     * 这个方法会智能地找到文本中的第一个 JSON 对象，考虑字符串中的大括号
     * 
     * @param text - 包含 JSON 的文本
     * @returns 解析后的 JSON 对象，如果提取失败则返回 null
     */
    private extractJsonFromText(text: string): unknown | null {
        const firstBrace = text.indexOf('{');
        if (firstBrace === -1) {
            return null;
        }

        let braceCount = 0;
        let lastBrace = -1;
        let inString = false;
        let escapeNext = false;
        
        // 智能匹配大括号，考虑字符串中的大括号和转义字符
        for (let i = firstBrace; i < text.length; i++) {
            const char = text[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\') {
                escapeNext = true;
                continue;
            }
            
            if (char === '"' && !escapeNext) {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        lastBrace = i;
                        break;
                    }
                }
            }
        }
        
        if (lastBrace === -1) {
            return null;
        }

        try {
            const jsonStr = text.substring(firstBrace, lastBrace + 1);
            this.logger.debug(`提取的JSON字符串长度: ${jsonStr.length}`);
            
            // 优先尝试原始 JSON，避免不必要的修改
            try {
                return JSON.parse(jsonStr);
            } catch (parseError) {
                this.logger.debug(`原始JSON解析失败，尝试修复转义字符: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
            }

            // 尝试修复常见的JSON转义问题（如Windows路径中的反斜杠）
            const repairedJsonStr = this.fixJsonEscapeChars(jsonStr);
            return JSON.parse(repairedJsonStr);
        } catch (parseError) {
            this.logger.debug(`提取的JSON对象解析失败: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
            return null;
        }
    }

    /**
     * 修复JSON字符串中的转义字符问题
     * 
     * 这个方法尝试修复AI返回的JSON中可能存在的转义字符问题，特别是Windows路径中的反斜杠。
     * 注意：这个方法只修复字符串值中的转义问题，不会破坏JSON结构。
     * 
     * 修复策略：
     * 1. 在字符串值中，查找未转义的反斜杠（后面不是有效转义字符的）
     * 2. 将这些反斜杠转义为双反斜杠
     * 
     * @param jsonStr - 需要修复的JSON字符串
     * @returns 修复后的JSON字符串
     */
    private fixJsonEscapeChars(jsonStr: string): string {
        // 修复JSON字符串中的转义字符问题
        // 策略：逐字符处理，只在字符串值内部修复未转义的反斜杠
        // 有效转义字符：", \, /, b, f, n, r, t, u (用于Unicode)
        
        let result = '';
        let inString = false;
        let escapeNext = false;
        
        for (let i = 0; i < jsonStr.length; i++) {
            const char = jsonStr[i];
            const nextChar = i + 1 < jsonStr.length ? jsonStr[i + 1] : null;
            
            if (escapeNext) {
                // 当前字符是转义序列的一部分，直接添加
                result += char;
                escapeNext = false;
                continue;
            }
            
            if (char === '\\') {
                if (inString) {
                    // 在字符串值中
                    if (nextChar && /["\\/bfnrtu]/.test(nextChar)) {
                        // 有效的转义序列（如 \", \\, \/, \b, \f, \n, \r, \t, \u）
                        result += char;
                        escapeNext = true; // 下一个字符是转义序列的一部分
                    } else {
                        // 无效的转义序列（如 \x, \后面跟其他字符）
                        // 可能是未转义的反斜杠，需要转义为双反斜杠
                        result += '\\\\';
                        // 下一个字符（如果存在）会在下一次循环中正常处理
                    }
                } else {
                    // 不在字符串中，可能是JSON结构的一部分，保留原样
                    result += char;
                }
                continue;
            }
            
            if (char === '"') {
                // 遇到双引号，切换字符串状态
                // 注意：转义的双引号 \" 不会触发这个分支，因为会被 escapeNext 处理
                inString = !inString;
                result += char;
                continue;
            }
            
            // 其他字符直接添加
            result += char;
        }
        
        return result;
    }

    /**
     * 解析自定义格式的响应
     * 
     * 使用 Zod Schema 验证自定义 API 返回的数据格式
     * 
     * @param responseData - API响应数据
     * @returns 标准化的审查响应（已通过 Zod 验证）
     */
    private parseCustomResponse(responseData: unknown): AIReviewResponse {
        try {
            const validatedResponse = AIReviewResponseSchema.parse(responseData);
            this.logger.info(`成功验证自定义API响应，发现 ${validatedResponse.issues.length} 个问题`);
            return validatedResponse;
        } catch (error) {
            if (error instanceof z.ZodError) {
                handleZodError(error, this.logger, '自定义API响应');
            }
            
            this.logger.error('解析自定义API响应失败', error);
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`解析自定义API响应失败: ${message}`);
        }
    }

    /**
     * 将API响应转换为ReviewIssue格式
     *
     * @param response - API响应
     * @param filesWithContent - 带内容的文件列表，用于 snippet 反查（diff 模式下可为片段）
     * @param options - useDiffLineNumbers 为 true 时直接使用响应中的 line/column（新文件行号）
     * @returns ReviewIssue列表
     */
    private transformToReviewIssues(
        response: AIReviewResponse,
        filesWithContent: Array<{ path: string; content: string }>,
        options?: { useDiffLineNumbers?: boolean }
    ): ReviewIssue[] {
        const config = this.config;
        if (!config) {
            return [];
        }

        const contentMap = new Map<string, string>(
            filesWithContent.map(file => [file.path, file.content])
        );
        const action = config.action;
        const useDiffLineNumbers = options?.useDiffLineNumbers === true;

        return response.issues.map(({ file, line = 1, column = 1, snippet, message, severity }) => {
            const resolvedPosition = useDiffLineNumbers
                ? { line, column }
                : (() => {
                    const content = contentMap.get(file);
                    return content
                        ? this.resolveIssuePositionFromSnippet(content, snippet, line, column)
                        : { line, column };
                })();

            return {
                file,
                line: resolvedPosition.line,
                column: resolvedPosition.column,
                message,
                rule: 'ai_review',
                severity: this.mapSeverity(severity, action)
            };
        });
    }

    /**
     * 通过 snippet 反查问题的真实行列号
     * 
     * 这是为了解决 AI 行号偏移问题：
     * - 优先使用 snippet 在文件内容中定位
     * - 定位失败时回退到 AI 返回的行列号
     * 
     * @param content - 文件原始内容
     * @param snippet - AI 返回的代码片段
     * @param fallbackLine - AI 返回的行号
     * @param fallbackColumn - AI 返回的列号
     * @returns 校正后的行列号（1-based）
     */
    private resolveIssuePositionFromSnippet = (
        content: string,
        snippet: string | undefined,
        fallbackLine: number,
        fallbackColumn: number
    ): { line: number; column: number } => {
        if (!snippet) {
            return { line: fallbackLine, column: fallbackColumn };
        }

        const normalizedContent = this.normalizeLineEndings(content);
        const normalizedSnippet = this.normalizeLineEndings(snippet);
        const snippetCandidates = [normalizedSnippet, normalizedSnippet.trim()].filter(value => value.length > 0);

        let matchIndex = -1;
        for (const candidate of snippetCandidates) {
            matchIndex = normalizedContent.indexOf(candidate);
            if (matchIndex >= 0) {
                break;
            }
        }

        if (matchIndex < 0) {
            return { line: fallbackLine, column: fallbackColumn };
        }

        const contentBefore = normalizedContent.slice(0, matchIndex);
        const line = contentBefore.split('\n').length;
        const lastNewlineIndex = contentBefore.lastIndexOf('\n');
        const column = lastNewlineIndex === -1
            ? matchIndex + 1
            : matchIndex - lastNewlineIndex;

        return { line, column };
    };

    /**
     * 统一换行符，避免 Windows 与 Unix 的行号偏差
     * 
     * @param text - 原始文本
     * @returns 统一为 \\n 的文本
     */
    private normalizeLineEndings = (text: string): string => {
        return text.replace(/\r\n/g, '\n');
    };

    /**
     * 映射严重程度
     * 根据配置的action调整severity
     * 
     * @param severity - API返回的严重程度
     * @param action - 配置的行为
     * @returns 映射后的严重程度
     */
    private mapSeverity(severity: 'error' | 'warning' | 'info', action: 'block_commit' | 'warning' | 'log'): 'error' | 'warning' | 'info' {
        // 如果配置为block_commit，所有问题都视为error
        if (action === 'block_commit') {
            return severity === 'info' ? 'warning' : severity;
        }
        // 如果配置为warning，error降级为warning
        if (action === 'warning') {
            return severity === 'error' ? 'warning' : severity;
        }
        // 如果配置为log，所有问题都视为info
        return 'info';
    }

    /**
     * 判断是否应该重试
     * 
     * @param error - 错误对象
     * @returns 是否应该重试
     */
    private shouldRetry(error: AxiosError): boolean {
        if (!error.response) {
            // 网络错误或超时，应该重试
            return true;
        }

        const status = error.response.status;
        
        // 5xx服务器错误，应该重试
        if (status >= 500) {
            return true;
        }
        
        // 429限流，应该重试
        if (status === 429) {
            return true;
        }
        
        // 其他错误（如401认证失败、400请求错误），不应该重试
        return false;
    }

    /**
     * 延迟函数
     * 
     * @param ms - 延迟毫秒数
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
