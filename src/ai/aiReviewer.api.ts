/**
 * AI 审查单次 HTTP 调用：构建请求体、发送请求、重试与续写、解析与合并缓存。
 *
 * 供 aiReviewer.ts 的 callAPI 委托调用，主文件只组 deps 并调用本模块。
 */
import axios, { AxiosInstance, AxiosError } from 'axios';
import type { Logger } from '../utils/logger';
import { RuntimeTraceLogger, type RuntimeTraceSession } from '../utils/runtimeTraceLogger';
import type { AIReviewConfig, AIReviewResponse } from './aiReviewer.types';
import { DEFAULT_MAX_RETRIES, DEFAULT_RETRY_DELAY, DEFAULT_MAX_TOKENS } from './aiReviewer.types';
import { buildOpenAIRequest, buildCustomRequest, buildContinuationOpenAIRequest } from './aiReviewer.prompts';
import { parseOpenAIResponse, parseCustomResponse } from './aiReviewer.responseParser';
import { estimateRequestChars } from './aiReviewer.batching';

/** callReviewAPI 所需依赖，由 AIReviewer 注入 */
export interface CallReviewAPIDeps {
    config: AIReviewConfig;
    axiosInstance: AxiosInstance;
    logger: Logger;
    runtimeTraceLogger: RuntimeTraceLogger;
    calculateRequestHash: (request: { files: Array<{ path: string; content: string }> }) => string;
    mergeCachedIssues: (requestHash: string, response: AIReviewResponse, isPartial: boolean) => AIReviewResponse;
    baseMessageCache: Map<string, Array<{ role: string; content: string }>>;
    shouldRetry: (error: AxiosError) => boolean;
    getRetryReason: (error: unknown) => string;
    sleep: (ms: number) => Promise<void>;
}

/**
 * 调用 AI API：构建请求、发送、重试、续写、解析并合并缓存。
 *
 * @param deps - 由 AIReviewer 提供的依赖
 * @param request - 待审查文件列表（含 content）
 * @param options - isDiffContent、diagnosticsByFile
 * @param traceSession - 运行时打点会话
 * @returns API 响应（issues 列表）
 */
export async function callReviewAPI(
    deps: CallReviewAPIDeps,
    request: { files: Array<{ path: string; content: string }> },
    options?: {
        isDiffContent?: boolean;
        diagnosticsByFile?: Map<string, Array<{ line: number; message: string }>>;
    },
    traceSession?: RuntimeTraceSession | null
): Promise<AIReviewResponse> {
    const {
        config,
        axiosInstance,
        logger,
        runtimeTraceLogger,
        calculateRequestHash,
        mergeCachedIssues,
        baseMessageCache,
        shouldRetry,
        getRetryReason,
        sleep,
    } = deps;

    if (!config) {
        throw new Error('AI 审查配置未初始化');
    }
    const url = (config.apiEndpoint || '').trim();
    if (!url || url.includes('${')) {
        throw new Error('AI API 端点/环境变量未解析，请在 .env 配置 AGENTREVIEW_AI_API_ENDPOINT 或在设置中填写完整 URL');
    }
    try {
        new URL(url);
    } catch {
        throw new Error(`AI API 端点 URL 无效: ${url.substring(0, 60)}${url.length > 60 ? '...' : ''}`);
    }

    const requestHash = calculateRequestHash(request);

    const requestBody = config.api_format === 'custom'
        ? buildCustomRequest(request)
        : buildOpenAIRequest(config, request, {
            isDiffContent: options?.isDiffContent,
            diagnosticsByFile: options?.diagnosticsByFile,
            logger,
        });

    const callStartAt = Date.now();
    const reportLlmCall = (opts: { durationMs: number; prompt_tokens?: number; completion_tokens?: number }): void => {
        if (traceSession) {
            runtimeTraceLogger.addLlmCall(traceSession.runId, {
                durationMs: opts.durationMs,
                prompt_tokens: opts.prompt_tokens,
                completion_tokens: opts.completion_tokens,
            });
        }
    };

    if (config.api_format !== 'custom') {
        const baseMessages = (requestBody as { messages: Array<{ role: string; content: string }> }).messages;
        baseMessageCache.set(requestHash, baseMessages);
    }

    const maxRetries = config.retry_count ?? DEFAULT_MAX_RETRIES;
    const baseDelay = config.retry_delay ?? DEFAULT_RETRY_DELAY;
    let lastError: Error | null = null;
    let continuationRequestBody: typeof requestBody | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const currentRequestBody = continuationRequestBody || requestBody;
            const response = await axiosInstance.post(
                url,
                currentRequestBody,
                { timeout: config.timeout }
            );

            if (config.api_format === 'custom') {
                const parsedResponse = parseCustomResponse(response.data, logger);
                const mergedResponse = mergeCachedIssues(requestHash, parsedResponse, false);
                reportLlmCall({ durationMs: Date.now() - callStartAt });
                return mergedResponse;
            }

            const parsedResult = parseOpenAIResponse(response.data, logger, config.max_tokens ?? DEFAULT_MAX_TOKENS);
            const mergedResponse = mergeCachedIssues(requestHash, parsedResult.response, parsedResult.isPartial);
            const durationMs = Date.now() - callStartAt;

            if (!parsedResult.isPartial) {
                reportLlmCall({
                    durationMs,
                    prompt_tokens: parsedResult.usage?.prompt_tokens,
                    completion_tokens: parsedResult.usage?.completion_tokens,
                });
                return mergedResponse;
            }

            logger.warn('AI 响应疑似被截断，尝试续写补全');

            if (attempt === maxRetries) {
                logger.warn('续写重试次数已用尽，返回已解析的部分结果');
                reportLlmCall({
                    durationMs,
                    prompt_tokens: parsedResult.usage?.prompt_tokens,
                    completion_tokens: parsedResult.usage?.completion_tokens,
                });
                return mergedResponse;
            }

            const baseMessages = baseMessageCache.get(requestHash);
            if (!baseMessages) {
                logger.warn('续写失败：未找到基础提示词，返回已解析的部分结果');
                reportLlmCall({
                    durationMs,
                    prompt_tokens: parsedResult.usage?.prompt_tokens,
                    completion_tokens: parsedResult.usage?.completion_tokens,
                });
                return mergedResponse;
            }

            continuationRequestBody = buildContinuationOpenAIRequest(config, {
                baseMessages,
                partialContent: parsedResult.cleanedContent,
                cachedIssues: mergedResponse.issues,
            });
            continue;
        } catch (error) {
            lastError = error as Error;

            if (attempt === maxRetries) {
                break;
            }

            if (shouldRetry(error as AxiosError)) {
                const delay = baseDelay * Math.pow(2, attempt);
                logger.warn(`AI API 调用失败，${delay}ms 后重试 (${attempt + 1}/${maxRetries})`);
                await sleep(delay);
            } else {
                throw error;
            }
        }
    }

    throw new Error(`AI API 调用失败（已重试 ${maxRetries} 次）: ${lastError?.message || '未知错误'}`);
}
