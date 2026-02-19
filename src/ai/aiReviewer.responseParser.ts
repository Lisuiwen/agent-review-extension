/**
 * AI 响应解析与 JSON 修复
 *
 * 解析 OpenAI 兼容 / 自定义 API 响应，处理截断与转义问题；通过 logger 参数打日志，不依赖 AIReviewer。
 */

import { z } from 'zod';
import type { Logger } from '../utils/logger';
import {
    AIReviewResponseSchema,
    OpenAIResponseSchema,
    handleZodError,
    DEFAULT_MAX_TOKENS,
    type AIReviewResponse,
} from './aiReviewer.types';

export type ParseOpenAIResult = {
    response: AIReviewResponse;
    isPartial: boolean;
    cleanedContent: string;
};

/** 清理 JSON：去掉 ```json ... ``` 包裹 */
export function cleanJsonContent(content: string, logger?: Logger): string {
    let cleaned = content.trim();
    const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
        cleaned = jsonBlockMatch[1].trim();
        logger?.debug('从代码块中提取JSON内容');
    }
    return cleaned;
}

/** 判断内容是否可能被截断（未闭合括号或字符串） */
export function isContentTruncated(content: string): boolean {
    const trimmed = content.trim();
    if (trimmed.endsWith('}')) {
        const openBraces = (trimmed.match(/\{/g) || []).length;
        const closeBraces = (trimmed.match(/\}/g) || []).length;
        if (openBraces !== closeBraces) return true;
    } else {
        return true;
    }
    const lastQuoteIndex = trimmed.lastIndexOf('"');
    if (lastQuoteIndex > 0) {
        const afterLastQuote = trimmed.substring(lastQuoteIndex + 1);
        if (!afterLastQuote.match(/^\s*[,}\]]/)) {
            const openQuotes = (trimmed.match(/"/g) || []).length;
            if (openQuotes % 2 !== 0) return true;
        }
    }
    return false;
}

/** 判断错误信息是否像截断导致的 JSON 错误 */
export function isTruncatedJsonError(errorMessage: string, content: string): boolean {
    const truncationPatterns = [
        /unterminated string/i,
        /unexpected end of json/i,
        /unexpected end of data/i,
        /position \d+.*end/i,
    ];
    const hasTruncationPattern = truncationPatterns.some((p) => p.test(errorMessage));
    const trimmedContent = content.trim();
    const endsWithIncomplete =
        trimmedContent.endsWith(',') ||
        trimmedContent.endsWith('"') ||
        trimmedContent.endsWith('\\') ||
        (trimmedContent.includes('"issues"') && !trimmedContent.endsWith('}'));
    return hasTruncationPattern || endsWithIncomplete;
}

/** 从截断的 JSON 中提取已完成的 issues 项 */
export function extractPartialJson(content: string, logger?: Logger): unknown {
    const issuesMatch = content.match(/"issues"\s*:\s*\[([\s\S]*)/);
    if (!issuesMatch) throw new Error('JSON被截断且无法提取issues数组');

    const issuesContent = issuesMatch[1];
    const issues: unknown[] = [];
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
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (!inString) {
            if (char === '{') {
                if (braceCount === 0) issueStart = i;
                braceCount++;
            } else if (char === '}') {
                braceCount--;
                if (braceCount === 0 && issueStart !== -1) {
                    try {
                        const issueStr = '{' + issuesContent.substring(issueStart, i + 1);
                        const issue = JSON.parse(issueStr);
                        issues.push(issue);
                        issueStart = -1;
                    } catch (e) {
                        logger?.debug(`跳过无效的issue对象: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            }
        }
    }

    if (issues.length === 0) throw new Error('JSON被截断且无法提取任何有效的issue对象');
    logger?.warn('JSON被截断，已提取部分可解析内容');
    return { issues };
}

/** 修复字符串内未转义的反斜杠等，便于解析 Windows 路径等 */
export function fixJsonEscapeChars(jsonStr: string): string {
    let result = '';
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < jsonStr.length; i++) {
        const char = jsonStr[i];
        const nextChar = i + 1 < jsonStr.length ? jsonStr[i + 1] : null;

        if (escapeNext) {
            result += char;
            escapeNext = false;
            continue;
        }
        if (char === '\\') {
            if (inString) {
                if (nextChar && /["\\/bfnrtu]/.test(nextChar)) {
                    result += char;
                    escapeNext = true;
                } else {
                    result += '\\\\';
                }
            } else {
                result += char;
            }
            continue;
        }
        if (char === '"') {
            inString = !inString;
            result += char;
            continue;
        }
        result += char;
    }
    return result;
}

/** 从文本中提取第一个完整 JSON 对象（匹配括号，考虑字符串内括号） */
export function extractJsonFromText(text: string, logger?: Logger): unknown | null {
    const firstBrace = text.indexOf('{');
    if (firstBrace === -1) return null;

    let braceCount = 0;
    let lastBrace = -1;
    let inString = false;
    let escapeNext = false;

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
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (!inString) {
            if (char === '{') braceCount++;
            else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                    lastBrace = i;
                    break;
                }
            }
        }
    }

    if (lastBrace === -1) return null;

    const jsonStr = text.substring(firstBrace, lastBrace + 1);
    logger?.debug(`提取的JSON字符串长度: ${jsonStr.length}`);

    try {
        return JSON.parse(jsonStr);
    } catch (parseError) {
        logger?.debug(`原始JSON解析失败，尝试修复转义字符: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }
    try {
        return JSON.parse(fixJsonEscapeChars(jsonStr));
    } catch {
        logger?.debug('提取的JSON对象解析失败');
        return null;
    }
}

/** 解析 JSON 字符串，截断时尝试提取部分；返回 parsed 与 isPartial */
export function parseJsonContent(
    content: string,
    logger: Logger
): { parsed: unknown; isPartial: boolean } {
    try {
        return { parsed: JSON.parse(content), isPartial: false };
    } catch (jsonError) {
        const errorMessage = jsonError instanceof Error ? jsonError.message : String(jsonError);
        logger.debug(`直接JSON解析失败: ${errorMessage}`);

        if (isTruncatedJsonError(errorMessage, content)) {
            logger.warn('检测到JSON可能被截断（达到max_tokens限制），尝试提取已解析的部分');
            return { parsed: extractPartialJson(content, logger), isPartial: true };
        }

        const extractedJson = extractJsonFromText(content, logger);
        if (!extractedJson) throw new Error(`无法从响应中提取有效的JSON对象。错误: ${errorMessage}`);
        return { parsed: extractedJson, isPartial: false };
    }
}

/** 解析 OpenAI 兼容响应，返回标准化 AIReviewResponse 与是否部分解析 */
export function parseOpenAIResponse(
    responseData: unknown,
    logger: Logger,
    maxTokens: number = DEFAULT_MAX_TOKENS
): ParseOpenAIResult {
    try {
        const openAIResponse = OpenAIResponseSchema.parse(responseData);
        const content = openAIResponse.choices[0].message.content;
        logger.debug(`AI返回内容长度: ${content.length} 字符`);

        const cleanedContent = cleanJsonContent(content, logger);
        if (isContentTruncated(cleanedContent)) {
            logger.warn('检测到响应内容可能被截断（可能达到max_tokens限制）');
            logger.warn(`当前max_tokens设置: ${maxTokens}`);
            logger.warn('建议：1) 增加max_tokens配置值；2) 减少审查的文件数量；3) 缩短问题描述');
        }

        const parseResult = parseJsonContent(cleanedContent, logger);
        const validatedResponse = AIReviewResponseSchema.parse(parseResult.parsed);
        logger.debug('AI响应解析与结构校验通过');
        return {
            response: validatedResponse,
            isPartial: parseResult.isPartial,
            cleanedContent,
        };
    } catch (error) {
        if (error instanceof z.ZodError) {
            handleZodError(error, logger, 'AI响应');
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('截断') || errorMessage.includes('truncated')) {
            logger.error('JSON响应被截断', { maxTokens, suggestion: '请增加max_tokens配置值或减少审查的文件数量' });
        }
        logger.error('解析OpenAI响应失败', error);
        throw new Error(`解析OpenAI响应失败: ${errorMessage}`);
    }
}

/** 解析自定义格式响应，直接校验为 AIReviewResponse */
export function parseCustomResponse(responseData: unknown, logger: Logger): AIReviewResponse {
    try {
        const validatedResponse = AIReviewResponseSchema.parse(responseData);
        logger.debug('自定义API响应结构校验通过');
        return validatedResponse;
    } catch (error) {
        if (error instanceof z.ZodError) {
            handleZodError(error, logger, '自定义API响应');
        }
        logger.error('解析自定义API响应失败', error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`解析自定义API响应失败: ${message}`);
    }
}
