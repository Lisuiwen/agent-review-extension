/**
 * AI 审查器主入口
 */
import * as path from 'path';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { ConfigManager } from '../config/configManager';
import { Logger } from '../utils/logger';
import type { ReviewIssue } from '../types/review';
import { FileScanner } from '../utils/fileScanner';
import type { FileDiff } from '../utils/diffTypes';
import type { AffectedScopeResult } from '../utils/astScope';
import * as lspContext from '../utils/lspContext';
import { RuntimeTraceLogger, type RuntimeTraceSession } from '../utils/runtimeTraceLogger';

import {
    type AIReviewConfig,
    type AIReviewRequest,
    type AIReviewResponse,
    AIReviewRequestSchema,
    handleZodError,
    DEFAULT_TIMEOUT,
    DEFAULT_BATCHING_MODE,
    DEFAULT_AST_SNIPPET_BUDGET,
    DEFAULT_AST_CHUNK_STRATEGY,
    DEFAULT_MAX_RETRIES,
    DEFAULT_RETRY_DELAY,
    DEFAULT_TEMPERATURE,
    DEFAULT_MAX_TOKENS,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_BATCH_CONCURRENCY,
    DEFAULT_MAX_REQUEST_CHARS,
} from './aiReviewer.types';
export type { AIReviewConfig, AIReviewRequest, AIReviewResponse } from './aiReviewer.types';

import { buildDiffSnippetForFile, buildAstSnippetForFile, buildStructuredReviewContent } from './aiReviewer.snippets';
import {
    buildReviewUnits,
    splitIntoBatches,
    splitUnitsBySnippetBudget,
    splitUnitsInHalf,
    countUnitSnippets,
    countAstSnippetMap,
    estimateRequestChars,
    getAstSnippetBudget,
    getBatchConcurrency,
    getMaxRequestChars,
    DEFAULT_BATCH_SIZE,
} from './aiReviewer.batching';
import type { ReviewUnit } from './aiReviewer.types';
import {
    normalizeDiagnosticsMap,
    filterIssuesByAllowedLines,
    pickDiagnosticsForFiles,
    attachAstRangesForBatch,
    filterIssuesByDiagnostics,
} from './aiReviewer.issueFilter';
import { buildOpenAIRequest, buildCustomRequest, buildContinuationOpenAIRequest, getLanguageFromExtension } from './aiReviewer.prompts';
import { parseOpenAIResponse, parseCustomResponse } from './aiReviewer.responseParser';
import { transformToReviewIssues, actionToSeverity } from './aiReviewer.transform';

/**
 * AI瀹℃煡鍣ㄧ被
 * 
 * 璐熻矗璋冪敤AI API杩涜浠ｇ爜瀹℃煡
 * 鏀寔OpenAI鍏煎鏍煎紡鍜岃嚜瀹氫箟鏍煎紡
 * 
 * const aiReviewer = new AIReviewer(configManager);
 * await aiReviewer.initialize();
 * const issues = await aiReviewer.review({ files: [...] });
 * ```
 */
export class AIReviewer {
    private configManager: ConfigManager;
    private logger: Logger;
    private fileScanner: FileScanner;
    private runtimeTraceLogger: RuntimeTraceLogger;
    private config: AIReviewConfig | null = null;
    private axiosInstance: AxiosInstance;
    private responseCache = new Map<string, { response: AIReviewResponse; isPartial: boolean }>();
    private baseMessageCache = new Map<string, Array<{ role: string; content: string }>>();

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
        this.logger = new Logger('AIReviewer');
        this.fileScanner = new FileScanner();
        this.runtimeTraceLogger = RuntimeTraceLogger.getInstance();
        
        // 鍒涘缓axios瀹炰緥锛岀粺涓€閰嶇疆
        this.axiosInstance = axios.create({
            timeout: DEFAULT_TIMEOUT,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // 璇锋眰鎷︽埅鍣細娣诲姞璁よ瘉淇℃伅
        // Moonshot API 浣跨敤 Bearer Token 璁よ瘉锛屾牸寮忥細Authorization: Bearer <api_key>
        this.axiosInstance.interceptors.request.use(
            (config) => {
                if (this.config?.apiKey) {
                    // 鍙傝€冿細https://platform.moonshot.cn/docs/guide/start-using-kimi-api
                    config.headers.Authorization = `Bearer ${this.config.apiKey}`;
                }
                return config;
            },
            (error) => Promise.reject(error)
        );
        
        // 鍝嶅簲鎷︽埅鍣細缁熶竴閿欒澶勭悊
        this.axiosInstance.interceptors.response.use(
            (response) => response,
            (error: AxiosError) => {
                this.logger.error(`AI API璋冪敤澶辫触: ${error.message}`);
                if (error.response?.status === 404) {
                    const body = error.response?.data as { error?: { message?: string; type?: string } } | undefined;
                    const msg = body?.error?.message ?? '';
                    this.logger.warn(`404 參原因：① 模型不存在或无权限（厂商文档?04 = 不存在 model ?Permission denied）② 竂地址错。当前使?model 见上方日志响? ${msg || JSON.stringify(body ?? '')}`);
                }
                return Promise.reject(error);
            }
        );
    }

    /**
     */
    async initialize(): Promise<void> {
        const config = this.configManager.getConfig();
        if (!config.ai_review) {
            this.config = null;
            return;
        }

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
            batching_mode: config.ai_review.batching_mode ?? DEFAULT_BATCHING_MODE,
            ast_snippet_budget: config.ai_review.ast_snippet_budget ?? DEFAULT_AST_SNIPPET_BUDGET,
            ast_chunk_strategy: config.ai_review.ast_chunk_strategy ?? DEFAULT_AST_CHUNK_STRATEGY,
            batch_concurrency: config.ai_review.batch_concurrency ?? DEFAULT_BATCH_CONCURRENCY,
            max_request_chars: config.ai_review.max_request_chars ?? DEFAULT_MAX_REQUEST_CHARS,
            action: config.ai_review.action
        };

        this.axiosInstance.defaults.timeout = this.config.timeout;

        const ep = this.config.apiEndpoint || '';
        const endpointResolved = !!ep && !ep.includes('${');
        if (ep && !endpointResolved) {
            this.logger.warn(`[竂朧析] 仍含占位符，请?.env 或罸的环境变? ${ep.substring(0, 60)}${ep.length > 60 ? '...' : ''}`);
        }
        if (!ep) {
            this.logger.warn('⚠️ AI API端点未配置，AI审查将无法执行');
        }
        if (!this.config.apiKey) {
            this.logger.warn('鈿狅笍 AI API瀵嗛挜鏈厤缃紝鍙兘瀵艰嚧璁よ瘉澶辫触');
        } else if (this.config.apiKey.startsWith('${') && this.config.apiKey.endsWith('}')) {
            this.logger.warn(`⚠️ AI API密钥变量朧? ${this.config.apiKey}`);
            this.logger.warn('璇风‘淇濊缃簡 OPENAI_API_KEY 鐜鍙橀噺锛屾垨鍦ㄩ」鐩牴鐩綍鍒涘缓 .env 鏂囦欢');
        }
    }

    /**
     * 鎵цAI瀹℃煡
     *
     * @returns 瀹℃煡闂鍒楄〃
     */
    async review(
        request: AIReviewRequest & {
            diffByFile?: Map<string, FileDiff>;
            astSnippetsByFile?: Map<string, AffectedScopeResult>;
            diagnosticsByFile?: Map<string, Array<{ line: number; message: string; range?: { startLine: number; endLine: number } }>>;
        },
        traceSession?: RuntimeTraceSession | null
    ): Promise<ReviewIssue[]> {
        const reviewStartAt = Date.now();
        const validatedRequest = this.validateRequest(request);
        const diffByFile = request.diffByFile;
        const astSnippetsByFile = request.astSnippetsByFile;
        const diagnosticsByFile = normalizeDiagnosticsMap(request.diagnosticsByFile);

        await this.ensureInitialized();
        if (!this.isConfigValid()) {
            return [];
        }

        this.resetReviewCache();

        const useDiffMode = this.config?.diff_only !== false && diffByFile && diffByFile.size > 0;
        const useAstSnippets = !!astSnippetsByFile && astSnippetsByFile.size > 0;
        const useDiffContent = useDiffMode || useAstSnippets;
        const astConfig = this.configManager.getConfig().ast;
        const enableLspContext = astConfig?.include_lsp_context !== false;
        const lspReferenceBuilder = (() => {
            try {
                const candidate = (lspContext as unknown as Record<string, unknown>).buildLspReferenceContext;
                return typeof candidate === 'function'
                    ? candidate as (filePath: string, snippets: AffectedScopeResult['snippets']) => Promise<string>
                    : null;
            } catch {
                return null;
            }
        })();
        const lspUsagesBuilder = (() => {
            try {
                const candidate = (lspContext as unknown as Record<string, unknown>).buildLspUsagesContext;
                return typeof candidate === 'function'
                    ? candidate as (filePath: string, snippets: AffectedScopeResult['snippets']) => Promise<string>
                    : null;
            } catch {
                return null;
            }
        })();
        const headerContextCache = new Map<string, string>();
        const getHeaderReferenceContext = async (filePath: string): Promise<string> => {
            const normalizedPath = path.normalize(filePath);
            const cached = headerContextCache.get(normalizedPath);
            if (cached !== undefined) {
                return cached;
            }
            const context = await this.buildFileHeaderReferenceContext(filePath);
            headerContextCache.set(normalizedPath, context);
            return context;
        };
        const filesToLoad = useDiffContent
            ? await Promise.all(validatedRequest.files.map(async (f) => {
                const normalizedPath = path.normalize(f.path);
                let content: string | undefined;
                let referenceContext = '';
                if (useAstSnippets) {
                    const astSnippets = astSnippetsByFile!.get(normalizedPath) ?? astSnippetsByFile!.get(f.path);
                    if (astSnippets?.snippets?.length) {
                        content = buildAstSnippetForFile(f.path, astSnippets);
                        if (enableLspContext) {
                            const definitionContext = lspReferenceBuilder
                                ? await lspReferenceBuilder(f.path, astSnippets.snippets)
                                : '';
                            const usagesContext = lspUsagesBuilder
                                ? await lspUsagesBuilder(f.path, astSnippets.snippets)
                                : '';
                            const parts: string[] = [];
                            if (definitionContext) parts.push(`## 渚濊禆瀹氫箟 (Definitions)\n${definitionContext}`);
                            if (usagesContext) parts.push(usagesContext);
                            referenceContext = parts.join('\n\n');
                        }
                        const headerContext = await getHeaderReferenceContext(f.path);
                        if (headerContext) {
                            referenceContext = referenceContext
                                ? `${headerContext}\n\n${referenceContext}`
                                : headerContext;
                        }
                    }
                }
                if (!content && useDiffMode) {
                    const fileDiff = diffByFile!.get(normalizedPath) ?? diffByFile!.get(f.path);
                    content = fileDiff?.hunks?.length
                        ? buildDiffSnippetForFile(f.path, fileDiff)
                        : undefined;
                    if (!content) {
                        this.logger.debug(`[diff_only] 文件 ${f.path} 未取得变更片段，回退整文件发送`);
                    }
                }
                if (!content && useAstSnippets) {
                    this.logger.debug(`[ast_only] 文件 ${f.path} 未取得 AST 片段，回退整文件发送`);
                }
                if (content && referenceContext) {
                    content = buildStructuredReviewContent(content, referenceContext);
                }
                return { path: f.path, content };
            }))
            : validatedRequest.files;

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

        // ---------- 鍔犺浇鏂囦欢鍐呭銆侀瑙堟ā寮忕煭璺€佹瀯寤哄鏌ュ崟鍏冧笌鎵规 ----------
        try {
            const previewOnly = astConfig?.preview_only === true;
            if (previewOnly) {
                this.logger.info('[ast.preview_only=true] 浠呴瑙堝垏鐗囷紝涓嶈姹傚ぇ妯″瀷');
            }
            const validFiles = await this.loadFilesWithContent(filesToLoad, previewOnly);
            if (validFiles.length === 0) {
                this.logger.warn('娌℃湁鍙鏌ョ殑鏂囦欢');
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

            const reviewUnits = buildReviewUnits(this.config, validFiles, {
                useAstSnippets,
                astSnippetsByFile,
                useDiffMode: !!useDiffMode,
                diffByFile: diffByFile ?? undefined,
            });
            if (reviewUnits.length === 0) {
                this.logger.warn('没有可审查单元');
                return [];
            }

            const useAstSnippetBatching = useAstSnippets && this.config?.batching_mode === 'ast_snippet';
            const batches = useAstSnippetBatching
                ? splitUnitsBySnippetBudget(reviewUnits, getAstSnippetBudget(this.config))
                : splitIntoBatches(reviewUnits, DEFAULT_BATCH_SIZE);

            // 鎵撶偣锛氭湰娆″鏌ョ殑鏂囦欢鏁般€佸崟鍏冩暟銆佹壒娆℃暟銆佸苟鍙戜笌棰勭畻锛屼究浜庢帓鏌ヤ笌璋冧紭
            const totalAstSnippetCount = countAstSnippetMap(astSnippetsByFile);
            const totalSnippetCount = countUnitSnippets(reviewUnits);
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'AIReviewer',
                event: 'ai_plan_summary',
                phase: 'ai',
                data: {
                    files: validatedRequest.files.length,
                    loadedFiles: validFiles.length,
                    units: reviewUnits.length,
                    batches: batches.length,
                    astSnippets: totalAstSnippetCount,
                    snippets: totalSnippetCount,
                    batchingMode: useAstSnippetBatching ? 'ast_snippet' : 'file_count',
                    concurrency: getBatchConcurrency(this.config),
                    budget: useAstSnippetBatching ? getAstSnippetBudget(this.config) : DEFAULT_BATCH_SIZE,
                },
            });

            const issues = await this.processReviewUnitBatches(batches, {
                useDiffContent,
                allowedLinesByFile,
                diagnosticsByFile,
                astSnippetsByFile: astSnippetsByFile ?? undefined,
            }, traceSession);
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'AIReviewer',
                event: 'ai_review_done',
                phase: 'ai',
                durationMs: Date.now() - reviewStartAt,
                data: {
                    scope: 'all_batches',
                },
            });
            return issues;
        } catch (error) {
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'AIReviewer',
                event: 'ai_batch_failed',
                phase: 'ai',
                level: 'warn',
                durationMs: Date.now() - reviewStartAt,
                data: {
                    scope: 'all_batches',
                    errorClass: error instanceof Error ? error.name : 'UnknownError',
                },
            });
            return this.handleReviewError(error);
        }
    }

    /**
     * 楠岃瘉杈撳叆璇锋眰
     * 
     * @param request - 寰呴獙璇佺殑璇锋眰
     * @returns 楠岃瘉鍚庣殑璇锋眰
     * @throws 濡傛灉楠岃瘉澶辫触
     */
    private buildFileHeaderReferenceContext = async (filePath: string): Promise<string> => {
        try {
            const content = await this.fileScanner.readFile(filePath);
            if (!content.trim()) {
                return '';
            }
            const lines = content.split(/\r?\n/);
            const maxScanLines = Math.min(lines.length, 200);
            const selected: string[] = [];
            const headerPattern = /^(?:import\s.+from\s+['\"].+['\"];?|import\s+['\"].+['\"];?|(?:export\s+)?(?:type|interface|enum)\s+\w+|const\s+\w+\s*=\s*require\(|(?:export\s+)?(?:const|let|var)\s+\w+\s*=|(?:export\s+)?(?:async\s+)?function\s+\w+|(?:export\s+)?class\s+\w+)/;

            for (let i = 0; i < maxScanLines; i++) {
                const rawLine = lines[i];
                const trimmed = rawLine.trim();
                if (!trimmed) {
                    continue;
                }
                if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) {
                    continue;
                }
                if (headerPattern.test(trimmed)) {
                    selected.push(`# 行${i + 1}`);
                    selected.push(rawLine);
                }
                if (selected.length >= 80) {
                    break;
                }
            }

            if (selected.length === 0) {
                return '';
            }
            const joined = selected.join('\n');
            const clipped = joined.length > 4000 ? `${joined.slice(0, 4000)}\n...ѽضϣ` : joined;
            return `## 文件头依赖上下文\n${clipped}`;
        } catch {
            return '';
        }
    };
    private validateRequest(request: AIReviewRequest): AIReviewRequest {
        try {
            return AIReviewRequestSchema.parse(request);
        } catch (error) {
            handleZodError(error, this.logger, 'AI瀹℃煡璇锋眰');
        }
    }

    /**
     * 纭繚閰嶇疆宸插垵濮嬪寲
     */
    private async ensureInitialized(): Promise<void> {
        await this.configManager.loadConfig();
        await this.initialize();
    }

    private isConfigValid(): boolean {
        if (!this.config) {
            this.logger.warn('AI瀹℃煡閰嶇疆涓嶅瓨鍦紝璺宠繃AI瀹℃煡');
            return false;
        }
        if (!this.config.enabled) {
            this.logger.info('AI审查未启用');
            return false;
        }
        const ep = (this.config.apiEndpoint || '').trim();
        if (!ep || ep.includes('${')) {
            this.logger.warn(
                ep.includes('${')
                    ? 'AI API˵㻷δ .env ϵͳ'
                    : 'AI API端点未配置'
            );
            return false;
        }
        try {
            new URL(ep);
        } catch {
            this.logger.warn('AI API绔偣URL鏍煎紡鏃犳晥');
            return false;
        }
        const model = (this.config.model || '').trim();
        if (!model || model.includes('${')) {
            this.logger.warn(
                model.includes('${')
                    ? 'AI ģͻδ'
                    : 'AI 模型未配置，请在设置或 .env 中配置 model'
            );
            return false;
        }
        this.validateApiKey();
        return true;
    }

    /**
     * 楠岃瘉 API 瀵嗛挜
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
     */
    private hasValidApiKey(): boolean {
        const { apiKey } = this.config!;
        const normalizedKey = apiKey?.trim() || '';
        return !!normalizedKey &&
            !normalizedKey.startsWith('${') &&
            !normalizedKey.includes('}') &&
            normalizedKey.length >= 8;
    }

    /** 加载文件内容（必要时从磁盘读取） */
    private async loadFilesWithContent(
        files: Array<{ path: string; content?: string }>,
        previewOnly = false
    ): Promise<Array<{ path: string; content: string }>> {
        const filesWithContent = await Promise.all(
            files.map(async (file) => {
                if (file.content !== undefined && file.content.trim().length > 0) {
                    return { path: file.path, content: file.content };
                }
                try {
                    const content = await this.fileScanner.readFile(file.path);
                    if (!previewOnly && content.length === 0) {
                        this.logger.warn(`鏂囦欢涓虹┖: ${file.path}`);
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

    private processReviewUnitBatches = async (
        batches: ReviewUnit[][],
        options: {
            useDiffContent: boolean;
            allowedLinesByFile: Map<string, Set<number>>;
            diagnosticsByFile: Map<string, Array<{ line: number; message: string; range?: { startLine: number; endLine: number } }>>;
            astSnippetsByFile?: Map<string, AffectedScopeResult>;
        },
        traceSession?: RuntimeTraceSession | null
    ): Promise<ReviewIssue[]> => {
        if (batches.length === 0) {
            return [];
        }

        const poolStartAt = Date.now();
        const maxConcurrency = Math.min(getBatchConcurrency(this.config), batches.length);
        const results: ReviewIssue[][] = new Array(batches.length);
        const processedUnitIds = new Set<string>();
        let nextBatchIndex = 0;

        const workers = Array.from({ length: maxConcurrency }, async () => {
            while (true) {
                const currentIndex = nextBatchIndex;
                nextBatchIndex++;
                if (currentIndex >= batches.length) {
                    break;
                }
                results[currentIndex] = await this.processSingleReviewBatch(
                    batches[currentIndex],
                    currentIndex + 1,
                    batches.length,
                    processedUnitIds,
                    options,
                    traceSession
                );
            }
        });

        await Promise.all(workers);
        const flattened = results.flat();
        // 鎵撶偣锛氭暣涓苟鍙戞睜鑰楁椂銆佹壒娆℃暟銆佸苟鍙戞暟
        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'AIReviewer',
            event: 'ai_pool_done',
            phase: 'ai',
            durationMs: Date.now() - poolStartAt,
            data: {
                scope: 'pool',
                batches: batches.length,
                concurrency: maxConcurrency,
            },
        });
        return flattened;
    };

    private processSingleReviewBatch = async (
        batch: ReviewUnit[],
        batchIndex: number,
        totalBatches: number,
        processedUnitIds: Set<string>,
        options: {
            useDiffContent: boolean;
            allowedLinesByFile: Map<string, Set<number>>;
            diagnosticsByFile: Map<string, Array<{ line: number; message: string; range?: { startLine: number; endLine: number } }>>;
            astSnippetsByFile?: Map<string, AffectedScopeResult>;
        },
        traceSession?: RuntimeTraceSession | null
    ): Promise<ReviewIssue[]> => {
        const batchStartAt = Date.now();
        const batchUnits = batch.filter(unit => {
            if (processedUnitIds.has(unit.unitId)) {
                this.logger.warn(`鎵瑰鐞嗛噸澶嶅鏌ュ崟鍏冨凡璺宠繃: ${unit.unitId}`);
                return false;
            }
            processedUnitIds.add(unit.unitId);
            return true;
        });

        if (batchUnits.length === 0) {
            this.logger.warn(`批次 ${batchIndex}/${totalBatches} 没有可审查单元，已跳过`);
            return [];
        }

        const batchSnippetCount = countUnitSnippets(batchUnits);
        const batchEstimatedChars = estimateRequestChars(
            batchUnits.map(unit => ({ path: unit.path, content: unit.content }))
        );
        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'AIReviewer',
            event: 'ai_batch_start',
            phase: 'ai',
            data: {
                batchIndex,
                totalBatches,
                units: batchUnits.length,
                snippets: batchSnippetCount,
                estimatedChars: batchEstimatedChars,
            },
        });

        try {
            const issues = await this.executeBatchWithFallback(batchUnits, options, true, traceSession);
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'AIReviewer',
                event: 'ai_batch_done',
                phase: 'ai',
                durationMs: Date.now() - batchStartAt,
                data: {
                    batchIndex,
                    totalBatches,
                    units: batchUnits.length,
                },
            });
            return issues;
        } catch (error) {
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'AIReviewer',
                event: 'ai_batch_failed',
                phase: 'ai',
                level: 'warn',
                durationMs: Date.now() - batchStartAt,
                data: {
                    batchIndex,
                    totalBatches,
                    errorClass: error instanceof Error ? error.name : 'UnknownError',
                },
            });
            return this.handleReviewError(error);
        }
    };

    private executeBatchWithFallback = async (
        batchUnits: ReviewUnit[],
        options: {
            useDiffContent: boolean;
            allowedLinesByFile: Map<string, Set<number>>;
            diagnosticsByFile: Map<string, Array<{ line: number; message: string; range?: { startLine: number; endLine: number } }>>;
            astSnippetsByFile?: Map<string, AffectedScopeResult>;
        },
        allowSplit: boolean,
        traceSession?: RuntimeTraceSession | null
    ): Promise<ReviewIssue[]> => {
        const batchFiles = batchUnits.map(unit => ({
            path: unit.path,
            content: unit.content,
        }));

        const estimatedChars = estimateRequestChars(batchFiles);
        const maxRequestChars = getMaxRequestChars(this.config);
        if (allowSplit && batchFiles.length > 1 && estimatedChars > maxRequestChars) {
            this.logger.warn(`[batch_guard] 鎵规浼扮畻闀垮害 ${estimatedChars} 瓒呰繃涓婇檺 ${maxRequestChars}锛屽皢浜屽垎闄嶈浇`);
            const [leftUnits, rightUnits] = splitUnitsInHalf(batchUnits);
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'AIReviewer',
                event: 'batch_split_triggered',
                phase: 'ai',
                level: 'warn',
                data: {
                    reason: 'max_request_chars',
                    leftUnits: leftUnits.length,
                    rightUnits: rightUnits.length,
                },
            });
            const leftIssues = await this.executeBatchWithFallback(leftUnits, options, false, traceSession);
            const rightIssues = await this.executeBatchWithFallback(rightUnits, options, false, traceSession);
            return [...leftIssues, ...rightIssues];
        }

        try {
            const diagnosticsForBatch = pickDiagnosticsForFiles(
                options.diagnosticsByFile,
                batchFiles.map(file => file.path)
            );
            const response = await this.callAPI(
                { files: batchFiles },
                {
                    isDiffContent: options.useDiffContent,
                    diagnosticsByFile: diagnosticsForBatch,
                },
                traceSession
            );
            const batchIssues = this.config
                ? transformToReviewIssues(this.config, response, batchFiles, { useDiffLineNumbers: options.useDiffContent })
                : [];
            const issuesInScope = filterIssuesByAllowedLines(batchIssues, options, this.logger);
            attachAstRangesForBatch(issuesInScope, options.astSnippetsByFile);
            return filterIssuesByDiagnostics(issuesInScope, diagnosticsForBatch, {
                logger: this.logger,
                onOverdropFallback: (data) =>
                    this.runtimeTraceLogger.logEvent({
                        session: traceSession,
                        component: 'AIReviewer',
                        event: 'diagnostics_filter_overdrop_fallback',
                        phase: 'ai',
                        level: 'warn',
                        data: { issuesBefore: data.issuesBefore, diagnosticsFiles: data.diagnosticsFiles },
                    }),
            });
        } catch (error) {
            if (allowSplit && batchFiles.length > 1 && this.isContextTooLongError(error)) {
                this.logger.warn('[batch_guard] 检测到上下文超限错误，批次将二分后重试一次');
                const [leftUnits, rightUnits] = splitUnitsInHalf(batchUnits);
                this.runtimeTraceLogger.logEvent({
                    session: traceSession,
                    component: 'AIReviewer',
                    event: 'batch_split_triggered',
                    phase: 'ai',
                    level: 'warn',
                    data: {
                        reason: 'context_too_long',
                        leftUnits: leftUnits.length,
                        rightUnits: rightUnits.length,
                    },
                });
                const leftIssues = await this.executeBatchWithFallback(leftUnits, options, false, traceSession);
                const rightIssues = await this.executeBatchWithFallback(rightUnits, options, false, traceSession);
                return [...leftIssues, ...rightIssues];
            }
            throw error;
        }
    };

    private isContextTooLongError = (error: unknown): boolean => {
        if (!axios.isAxiosError(error)) return false;
        const status = error.response?.status;
        if (status === 413) return true;
        const responseText = typeof error.response?.data === 'string'
            ? error.response.data
            : JSON.stringify(error.response?.data ?? '');
        const tooLongPattern = /(context|context_length_exceeded|too many tokens|max(?:imum)? context|prompt too long|request too large|payload too large)/;
        return status === 400 && tooLongPattern.test(`${error.message} ${responseText}`.toLowerCase());
    };

    /** 澶勭悊瀹℃煡閿欒锛歜lock_commit 鏃舵姏鍑猴紝鍚﹀垯杩斿洖鍗曟潯 issue */
    private handleReviewError(error: unknown): ReviewIssue[] {
        this.logger.error('AI瀹℃煡澶辫触', error);
        const action = this.config?.action ?? 'warning';
        const message = error instanceof Error ? error.message : String(error);
        const isTimeout = axios.isAxiosError(error) && (error.code === 'ECONNABORTED' || /timeout/i.test(error.message));
        const userMessage = isTimeout
            ? `AI鳬ʱ${this.config?.timeout ?? DEFAULT_TIMEOUT}msԺ`
            : `AI瀹℃煡澶辫触: ${message}`;
        const rule = isTimeout ? 'ai_review_timeout' : 'ai_review_error';

        if (action === 'block_commit') throw new Error(userMessage);
        return [{ file: '', line: 1, column: 1, message: userMessage, rule, severity: actionToSeverity(action) }];
    }

    /** 重置审查缓存 */
    private resetReviewCache = (): void => {
        this.baseMessageCache.clear();
    };

    /**
     * 璋冪敤AI API
     *
     * @returns API鍝嶅簲
     */
    private async callAPI(
        request: { files: Array<{ path: string; content: string }> },
        options?: {
            isDiffContent?: boolean;
            diagnosticsByFile?: Map<string, Array<{ line: number; message: string }>>;
        },
        traceSession?: RuntimeTraceSession | null
    ): Promise<AIReviewResponse> {
        if (!this.config) {
            throw new Error('AI瀹℃煡閰嶇疆鏈垵濮嬪寲');
        }
        const url = (this.config.apiEndpoint || '').trim();
        if (!url || url.includes('${')) {
            throw new Error('AI API竂朅罈变量朧析，请在 .env ?AGENTREVIEW_AI_API_ENDPOINT 或在设置両写完?URL');
        }
        try {
            new URL(url);
        } catch {
            throw new Error(`AI API竂URL无效: ${url.substring(0, 60)}${url.length > 60 ? '...' : ''}`);
        }

        const requestHash = this.calculateRequestHash(request);

        const requestBody = this.config.api_format === 'custom'
            ? buildCustomRequest(request)
            : buildOpenAIRequest(this.config, request, {
                isDiffContent: options?.isDiffContent,
                diagnosticsByFile: options?.diagnosticsByFile,
                logger: this.logger,
            });

        const userMsgForLog = (requestBody as { messages?: Array<{ role: string; content: string }> }).messages?.find(m => m.role === 'user');
        const inputLen = userMsgForLog?.content?.length ?? estimateRequestChars(request.files);
        const mode = options?.isDiffContent ? 'diff_or_ast' : 'full';
        const callStartAt = Date.now();
        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'AIReviewer',
            event: 'llm_call_start',
            phase: 'ai',
            data: {
                mode,
                files: request.files.length,
                inputChars: inputLen,
            },
        });
        const logCallSummary = (attempts: number, partial: boolean): void => {
            this.runtimeTraceLogger.logEvent({
                session: traceSession,
                component: 'AIReviewer',
                event: 'llm_call_done',
                phase: 'ai',
                durationMs: Date.now() - callStartAt,
                data: {
                    mode,
                    files: request.files.length,
                    attempts,
                    partial,
                    inputChars: inputLen,
                },
            });
        };

        if (this.config.api_format !== 'custom') {
            const baseMessages = (requestBody as { messages: Array<{ role: string; content: string }> }).messages;
            this.baseMessageCache.set(requestHash, baseMessages);
        }

        // 瀹炵幇閲嶈瘯鏈哄埗锛堟寚鏁伴€€閬匡級
        const maxRetries = this.config.retry_count ?? DEFAULT_MAX_RETRIES;
        const baseDelay = this.config.retry_delay ?? DEFAULT_RETRY_DELAY;
        let lastError: Error | null = null;
        let continuationRequestBody: typeof requestBody | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const currentRequestBody = continuationRequestBody || requestBody;
                const response = await this.axiosInstance.post(
                    url,
                    currentRequestBody,
                    { timeout: this.config.timeout }
                );

                // 鏍规嵁API鏍煎紡瑙ｆ瀽鍝嶅簲
                if (this.config.api_format === 'custom') {
                    const parsedResponse = parseCustomResponse(response.data, this.logger);
                    const mergedResponse = this.mergeCachedIssues(requestHash, parsedResponse, false);
                    logCallSummary(attempt + 1, false);
                    return mergedResponse;
                }

                const parsedResult = parseOpenAIResponse(response.data, this.logger, this.config.max_tokens ?? DEFAULT_MAX_TOKENS);
                const mergedResponse = this.mergeCachedIssues(requestHash, parsedResult.response, parsedResult.isPartial);

                if (!parsedResult.isPartial) {
                    logCallSummary(attempt + 1, false);
                    return mergedResponse;
                }

                this.logger.warn('AI鍝嶅簲鐤戜技琚埅鏂紝灏濊瘯缁啓琛ュ叏');

                if (attempt === maxRetries) {
                    this.logger.warn('缁啓閲嶈瘯娆℃暟宸茬敤灏斤紝杩斿洖宸茶В鏋愮殑閮ㄥ垎缁撴灉');
                    logCallSummary(attempt + 1, true);
                    return mergedResponse;
                }

                const baseMessages = this.baseMessageCache.get(requestHash);
                if (!baseMessages) {
                    this.logger.warn('缁啓澶辫触锛氭湭鎵惧埌鍩虹鎻愮ず璇嶏紝杩斿洖宸茶В鏋愮殑閮ㄥ垎缁撴灉');
                    logCallSummary(attempt + 1, true);
                    return mergedResponse;
                }

                continuationRequestBody = buildContinuationOpenAIRequest(this.config, {
                    baseMessages,
                    partialContent: parsedResult.cleanedContent,
                    cachedIssues: mergedResponse.issues,
                });
                continue;
            } catch (error) {
                lastError = error as Error;
                
                // 濡傛灉鏄渶鍚庝竴娆″皾璇曪紝鐩存帴鎶涘嚭閿欒
                if (attempt === maxRetries) {
                    break;
                }

                // 鍒ゆ柇鏄惁搴旇閲嶈瘯
                if (this.shouldRetry(error as AxiosError)) {
                    const delay = baseDelay * Math.pow(2, attempt);
                    this.logger.warn(`AI API调用失败?{delay}ms后重?(${attempt + 1}/${maxRetries})`);
                    this.runtimeTraceLogger.logEvent({
                        session: traceSession,
                        component: 'AIReviewer',
                        event: 'llm_retry_scheduled',
                        phase: 'ai',
                        level: 'warn',
                        data: {
                            mode,
                            attempt: attempt + 1,
                            delayMs: delay,
                            statusCode: axios.isAxiosError(error) ? (error.response?.status ?? 0) : 0,
                            reason: this.getRetryReason(error),
                        },
                    });
                    await this.sleep(delay);
                } else {
                    this.runtimeTraceLogger.logEvent({
                        session: traceSession,
                        component: 'AIReviewer',
                        event: 'llm_call_abort',
                        phase: 'ai',
                        level: 'warn',
                        durationMs: Date.now() - callStartAt,
                        data: {
                            mode,
                            files: request.files.length,
                            attempts: attempt + 1,
                            inputChars: inputLen,
                            errorClass: error instanceof Error ? error.name : 'UnknownError',
                        },
                    });
                    // 涓嶅簲璇ラ噸璇曠殑閿欒锛堝401璁よ瘉澶辫触锛夛紝鐩存帴鎶涘嚭
                    throw error;
                }
            }
        }

        this.runtimeTraceLogger.logEvent({
            session: traceSession,
            component: 'AIReviewer',
            event: 'llm_call_failed',
            phase: 'ai',
            level: 'warn',
            durationMs: Date.now() - callStartAt,
            data: {
                mode,
                files: request.files.length,
                attempts: maxRetries + 1,
                inputChars: inputLen,
                errorClass: lastError?.name ?? 'UnknownError',
            },
        });
        throw new Error(`AI API调用失败（已重试${maxRetries}次）: ${lastError?.message || '期错'}`);
    }


    /** 生成请求哈希，用于缓存和续写关联 */
    private calculateRequestHash = (request: { files: Array<{ path: string; content: string }> }): string => {
        const raw = request.files
            .map(file => `${file.path}:${file.content}`)
            .join('|');
        return this.simpleHash(raw);
    };

    /** 简单字符串哈希 */
    private simpleHash = (input: string): string => {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            hash = (hash << 5) - hash + input.charCodeAt(i);
            hash |= 0;
        }
        return `${hash}`;
    };

    /** 合并缓存中的 issues，避免续写场景重复 */
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
     * 鍘婚噸 issues锛岄伩鍏嶇画鍐欏甫鏉ョ殑閲嶅缁撴灉
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

    private shouldRetry(error: AxiosError): boolean {
        if (!error.response) return true;
        const status = error.response.status;
        return status >= 500 || status === 429;
    }

    /**
     * 灏嗛噸璇曞師鍥犲綊涓€鍖栦负鍙垎鏋愬瓧娈碉紝渚夸簬鍚庣画缁熻璋冪敤澶辫触鍒嗗竷
     */
    private getRetryReason = (error: unknown): string => {
        if (!axios.isAxiosError(error)) {
            return 'unknown';
        }
        if (!error.response) {
            if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message)) {
                return 'timeout';
            }
            return 'network';
        }
        const status = error.response.status;
        if (status === 429) {
            return 'rate_limit';
        }
        if (status >= 500) {
            return 'server_error';
        }
        return `http_${status}`;
    };

    /** 延迟函数 */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
