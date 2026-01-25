import axios, { AxiosInstance, AxiosError } from 'axios';
import { z } from 'zod';
import { ConfigManager, AgentReviewConfig } from '../config/configManager';
import { Logger } from '../utils/logger';
import { ReviewIssue } from './reviewEngine';
import { FileScanner } from '../utils/fileScanner';

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
const DEFAULT_MODEL = 'gpt-4';
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

        // 转换配置格式
        this.config = {
            enabled: config.ai_review.enabled,
            api_format: config.ai_review.api_format || 'openai',
            apiEndpoint: config.ai_review.api_endpoint,
            apiKey: config.ai_review.api_key,
            model: config.ai_review.model || DEFAULT_MODEL,
            timeout: config.ai_review.timeout || DEFAULT_TIMEOUT,
            temperature: config.ai_review.temperature ?? DEFAULT_TEMPERATURE,
            max_tokens: config.ai_review.max_tokens || DEFAULT_MAX_TOKENS,
            system_prompt: config.ai_review.system_prompt || DEFAULT_SYSTEM_PROMPT,
            retry_count: config.ai_review.retry_count ?? DEFAULT_MAX_RETRIES,
            retry_delay: config.ai_review.retry_delay || DEFAULT_RETRY_DELAY,
            action: config.ai_review.action
        };

        // 更新axios实例的超时时间
        this.axiosInstance.defaults.timeout = this.config.timeout;

        this.logger.info(`AI审查服务已初始化: enabled=${this.config.enabled}, format=${this.config.api_format}, endpoint=${this.config.apiEndpoint || '未配置'}, model=${this.config.model}`);
        
        // 检查关键配置
        if (!this.config.apiEndpoint) {
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
     * 使用 Zod Schema 验证输入请求，确保数据格式正确
     * 
     * @param request - 审查请求，包含文件路径列表
     * @returns 审查问题列表
     */
    async review(request: AIReviewRequest): Promise<ReviewIssue[]> {
        // 验证输入请求
        const validatedRequest = this.validateRequest(request);
        this.logger.info(`AI审查 ${validatedRequest.files.length} 个文件`);
        
        // 确保配置已初始化
        await this.ensureInitialized();
        
        // 检查配置是否可用
        if (!this.isConfigValid()) {
            return [];
        }

        try {
            // 读取文件内容
            const validFiles = await this.loadFilesWithContent(validatedRequest.files);
            
            if (validFiles.length === 0) {
                this.logger.warn('没有可审查的文件');
                return [];
            }

            // 调用API并转换结果
            const response = await this.callAPI({ files: validFiles });
            return this.transformToReviewIssues(response);
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
     */
    private async ensureInitialized(): Promise<void> {
        if (!this.config) {
            this.logger.warn('AI审查配置未初始化，尝试重新初始化');
            await this.initialize();
        }
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

        if (!this.config.apiEndpoint) {
            this.logger.warn('AI API端点未配置');
            return false;
        }
        
        this.validateApiKey();
        this.logger.info(`AI审查配置检查通过: endpoint=${this.config.apiEndpoint}, hasApiKey=${this.hasValidApiKey()}`);
        return true;
    }

    /**
     * 验证 API 密钥
     */
    private validateApiKey(): void {
        const { apiKey } = this.config!;
        if (!apiKey || apiKey === '${OPENAI_API_KEY}' || apiKey.startsWith('${')) {
            this.logger.warn('AI API密钥未配置或环境变量未解析');
            this.logger.warn('请确保设置了 OPENAI_API_KEY 环境变量，或在 .env 文件中配置');
        }
    }

    /**
     * 检查是否有有效的 API 密钥
     */
    private hasValidApiKey(): boolean {
        const { apiKey } = this.config!;
        return !!apiKey && !apiKey.startsWith('${');
    }

    /**
     * 加载文件内容
     * 
     * @param files - 文件列表（可能只有路径）
     * @returns 包含内容的文件列表
     */
    private async loadFilesWithContent(files: Array<{ path: string; content?: string }>): Promise<Array<{ path: string; content: string }>> {
        const filesWithContent = await Promise.all(
            files.map(async (file) => {
                // 如果文件已有内容且不为空，直接使用
                // 注意：如果 content 是空字符串，也需要读取文件
                if (file.content !== undefined && file.content.trim().length > 0) {
                    this.logger.debug(`使用已提供的文件内容: ${file.path} (长度: ${file.content.length})`);
                    return { path: file.path, content: file.content };
                }
                
                // 否则读取文件内容
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
     * 处理审查错误
     * 
     * @param error - 错误对象
     * @returns 空数组或抛出错误
     */
    private handleReviewError(error: unknown): ReviewIssue[] {
        this.logger.error('AI审查失败', error);
        
        if (this.config?.action === 'block_commit') {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`AI审查失败: ${message}`);
        }
        
        return [];
    }

    /**
     * 调用AI API
     * 
     * @param request - 审查请求（文件必须包含content）
     * @returns API响应
     */
    private async callAPI(request: { files: Array<{ path: string; content: string }> }): Promise<AIReviewResponse> {
        if (!this.config) {
            throw new Error('AI审查配置未初始化');
        }

        // 根据API格式选择请求构建方法
        const requestBody = this.config.api_format === 'custom'
            ? this.buildCustomRequest(request)
            : this.buildOpenAIRequest(request);

        // 实现重试机制（指数退避）
        const maxRetries = this.config.retry_count ?? DEFAULT_MAX_RETRIES;
        const baseDelay = this.config.retry_delay ?? DEFAULT_RETRY_DELAY;
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                this.logger.debug(`AI API调用 (尝试 ${attempt + 1}/${maxRetries + 1})`);
                
                const response = await this.axiosInstance.post(
                    this.config.apiEndpoint,
                    requestBody,
                    { timeout: this.config.timeout }
                );

                // 根据API格式解析响应
                return this.config.api_format === 'custom'
                    ? this.parseCustomResponse(response.data)
                    : this.parseOpenAIResponse(response.data);
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
     * @param request - 审查请求（文件必须包含content）
     * @returns OpenAI/Moonshot 兼容格式的请求体
     */
    private buildOpenAIRequest(request: { files: Array<{ path: string; content: string }> }): {
        model: string;
        messages: Array<{ role: string; content: string }>;
        temperature: number;
        max_tokens: number;
    } {
        if (!this.config) {
            throw new Error('AI审查配置未初始化');
        }

        // 构建用户提示词
        // 将多个文件的内容组合在一起，每个文件用代码块包裹
        const filesContent = request.files.map(file => {
            // 获取文件扩展名，用于代码高亮
            const ext = file.path.split('.').pop() || '';
            const language = this.getLanguageFromExtension(ext);
            
            // 记录文件内容长度，用于调试
            const content = file.content; // 此时content一定存在（由loadFilesWithContent保证）
            const contentLength = content.length;
            this.logger.debug(`构建请求 - 文件: ${file.path}, 内容长度: ${contentLength} 字符`);
            
            if (contentLength === 0) {
                this.logger.warn(`警告: 文件内容为空: ${file.path}`);
            } else if (contentLength < 100) {
                this.logger.debug(`文件内容预览 (前${Math.min(100, contentLength)}字符): ${content.substring(0, 100)}`);
            }
            
            return `文件: ${file.path}\n\`\`\`${language}\n${content}\n\`\`\``;
        }).join('\n\n');
        
        // 记录总的内容长度
        const totalContentLength = filesContent.length;
        this.logger.debug(`构建的提示词总长度: ${totalContentLength} 字符`);

        // 构建用户提示词，明确要求返回 JSON 格式
        const userPrompt = `请仔细审查以下代码文件，进行全面的代码审查分析。

${filesContent}

**审查要求：**
1. 逐行分析代码，查找所有潜在问题
2. 检查bug、性能问题、安全问题、代码质量问题
3. 即使代码能正常运行，也要提供改进建议和最佳实践
4. 对于每个问题，提供详细的问题描述和具体的修复建议
5. 确保问题描述清晰、具体，包含：
   - 问题是什么
   - 为什么这是问题
   - 如何修复（提供具体的代码建议）

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
            model: this.config.model || DEFAULT_MODEL,
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
     * @returns 标准化的审查响应（已通过 Zod 验证）
     */
    private parseOpenAIResponse(responseData: unknown): AIReviewResponse {
        try {
            // 验证 OpenAI API 响应格式
            const openAIResponse = OpenAIResponseSchema.parse(responseData);
            const content = openAIResponse.choices[0].message.content;

            this.logger.debug(`AI返回内容长度: ${content.length} 字符`);
            this.logger.debug(`AI返回内容前500字符: ${content.substring(0, 500)}`);

            // 清理内容并提取 JSON
            const cleanedContent = this.cleanJsonContent(content);
            
            // 检查内容是否可能被截断
            if (this.isContentTruncated(cleanedContent)) {
                this.logger.warn('检测到响应内容可能被截断（可能达到max_tokens限制）');
                this.logger.warn(`当前max_tokens设置: ${this.config?.max_tokens || DEFAULT_MAX_TOKENS}`);
                this.logger.warn('建议：1) 增加max_tokens配置值；2) 减少审查的文件数量；3) 缩短问题描述');
            }
            
            const parsed = this.parseJsonContent(cleanedContent);

            // 验证解析后的数据
            const validatedResponse = AIReviewResponseSchema.parse(parsed);
            
            this.logger.info(`成功解析并验证AI响应，发现 ${validatedResponse.issues.length} 个问题`);
            return validatedResponse;
            
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
     * @returns 解析后的对象
     * @throws 如果解析失败
     */
    private parseJsonContent(content: string): unknown {
        try {
            return JSON.parse(content);
        } catch (jsonError) {
            const errorMessage = jsonError instanceof Error ? jsonError.message : String(jsonError);
            this.logger.debug(`直接JSON解析失败: ${errorMessage}`);
            
            // 检查是否是截断错误
            if (this.isTruncatedJsonError(errorMessage, content)) {
                this.logger.warn('检测到JSON可能被截断（达到max_tokens限制），尝试提取已解析的部分');
                return this.extractPartialJson(content);
            }
            
            // 尝试提取完整的JSON对象
            const extractedJson = this.extractJsonFromText(content);
            if (!extractedJson) {
                throw new Error(`无法从响应中提取有效的JSON对象。错误: ${errorMessage}`);
            }
            
            return extractedJson;
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
            let jsonStr = text.substring(firstBrace, lastBrace + 1);
            this.logger.debug(`提取的JSON字符串长度: ${jsonStr.length}`);
            
            // 尝试修复常见的JSON转义问题（如Windows路径中的反斜杠）
            jsonStr = this.fixJsonEscapeChars(jsonStr);
            
            return JSON.parse(jsonStr);
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
     * @returns ReviewIssue列表
     */
    private transformToReviewIssues(response: AIReviewResponse): ReviewIssue[] {
        const config = this.config;
        if (!config) {
            return [];
        }

        // 保存action值，避免在map回调中重复访问可能为null的对象
        const action = config.action;

        return response.issues.map(({ file, line = 1, column = 1, message, severity }) => ({
            file,
            line,
            column,
            message,
            rule: 'ai_review',
            severity: this.mapSeverity(severity, action),
            fixable: false
        }));
    }

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
