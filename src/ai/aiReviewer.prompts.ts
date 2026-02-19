/**
 * 提示词与请求体构建
 *
 * OpenAI 兼容 / 自定义格式的请求体、已知问题白名单、续写请求；依赖 aiReviewer.types 中的配置与常量。
 */

import type { Logger } from '../utils/logger';
import type { AIReviewConfig, AIReviewResponse } from './aiReviewer.types';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS } from './aiReviewer.types';

const LANGUAGE_MAP: Record<string, string> = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', java: 'java', cpp: 'cpp', c: 'c', cs: 'csharp', go: 'go', rs: 'rust',
    php: 'php', rb: 'ruby', swift: 'swift', kt: 'kotlin', scala: 'scala', sh: 'bash',
    yaml: 'yaml', yml: 'yaml', json: 'json', xml: 'xml', html: 'html', css: 'css',
    scss: 'scss', vue: 'vue', sql: 'sql',
};

/** 根据扩展名返回代码块语言标识 */
export function getLanguageFromExtension(ext: string): string {
    return LANGUAGE_MAP[ext.toLowerCase()] ?? ext.toLowerCase();
}

/** 生成「已知问题白名单」提示词，减少与 Linter/TS 重复报告 */
export function buildKnownDiagnosticsPrompt(
    diagnosticsByFile?: Map<string, Array<{ line: number; message: string }>>
): string {
    if (!diagnosticsByFile || diagnosticsByFile.size === 0) return '';
    const rows: string[] = [];
    for (const [filePath, diagnostics] of diagnosticsByFile.entries()) {
        for (const item of diagnostics.slice(0, 10)) {
            rows.push(`- ${filePath} 行 ${item.line}: ${item.message}`);
        }
    }
    if (rows.length === 0) return '';
    return ['**已知问题白名单（Linter/TS 已发现，AI 请勿重复报告）：**', ...rows, ''].join('\n');
}

export type OpenAIRequestBody = {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature: number;
    max_tokens: number;
};

/** 构建 OpenAI 兼容格式的审查请求体 */
export function buildOpenAIRequest(
    config: AIReviewConfig,
    request: { files: Array<{ path: string; content: string }> },
    options: {
        isDiffContent?: boolean;
        diagnosticsByFile?: Map<string, Array<{ line: number; message: string }>>;
        projectRulesSummary?: string;
        logger?: Logger;
    } = {}
): OpenAIRequestBody {
    const baseSystem = config.system_prompt || DEFAULT_SYSTEM_PROMPT;
    const systemContent = options.projectRulesSummary?.trim()
        ? `${baseSystem}\n\n**项目约定（请遵守，勿建议与之冲突的修改）：**\n${options.projectRulesSummary.trim()}`
        : baseSystem;

    const filesContent = request.files.map((file) => {
        const ext = file.path.split('.').pop() || '';
        const language = getLanguageFromExtension(ext);
        if (file.content.length === 0) options.logger?.warn(`警告: 文件内容为空: ${file.path}`);
        return `文件: ${file.path}\n\`\`\`${language}\n${file.content}\n\`\`\``;
    }).join('\n\n');

    const intro = options.isDiffContent
        ? '请仅针对以下**变更相关片段（diff/AST）**进行代码审查（非整文件）。片段中已用「# 行 N」标注新文件行号。'
        : '请仔细审查以下代码文件，进行全面的代码审查分析。';
    const lineHint = options.isDiffContent
        ? '返回的 **line** 必须使用上述「# 行 N」中标注的新文件行号（从 1 开始）。'
        : '';
    const knownIssuesPrompt = buildKnownDiagnosticsPrompt(options.diagnosticsByFile);

    const userPrompt = `${intro}

${filesContent}

${knownIssuesPrompt}

**审查要求：**
1. 逐行分析代码，查找所有潜在问题
2. 检查bug、性能问题、安全问题、代码质量问题
3. 即使代码能正常运行，也要提供改进建议和最佳实践
4. 对于每个问题，提供详细的问题描述和具体的修复建议
5. 返回 snippet 字段（问题所在的原始代码片段，1-3行，必须来自原文件，保持原样）
6. 若输入中包含「外部引用上下文（仅供参考）」，请不要对该上下文已定义的符号重复报“未定义”
7. 确保问题描述清晰、具体，包含：
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

    return {
        model: config.model || '',
        messages: [{ role: 'system', content: systemContent }, { role: 'user', content: userPrompt }],
        temperature: config.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: config.max_tokens || DEFAULT_MAX_TOKENS,
    };
}

/** 构建续写请求体（截断后继续输出剩余 issues） */
export function buildContinuationOpenAIRequest(
    config: AIReviewConfig,
    params: {
        baseMessages: Array<{ role: string; content: string }>;
        partialContent: string;
        cachedIssues: AIReviewResponse['issues'];
    }
): OpenAIRequestBody {
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
        model: config.model || '',
        messages: [
            ...params.baseMessages,
            { role: 'assistant', content: params.partialContent },
            { role: 'user', content: continuationPrompt },
        ],
        temperature: config.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: config.max_tokens || DEFAULT_MAX_TOKENS,
    };
}

/** 构建自定义格式请求体（仅透传 files） */
export function buildCustomRequest(request: { files: Array<{ path: string; content: string }> }): { files: Array<{ path: string; content: string }> } {
    return { files: request.files.map(({ path, content }) => ({ path, content })) };
}
