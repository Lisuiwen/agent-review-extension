/**
 * AI 瀹℃煡鍣ㄤ富鍏ュ彛
 *
 * 璐熻矗閰嶇疆鍔犺浇銆乺eview 娴佺▼缂栨帓銆丠TTP 璋冪敤涓庨噸璇曘€佺紦瀛樹笌缁啓锛涘叿浣撻€昏緫濮旀墭缁?aiReviewer.* 瀛愭ā鍧椼€? */
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
 * 璐熻矗璋冪敤AI API杩涜浠ｇ爜瀹℃煡
 * 鏀寔OpenAI鍏煎鏍煎紡鍜岃嚜瀹氫箟鏍煎紡
 * 
 * 浣跨敤鏂瑰紡锛? * ```typescript
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
        // Moonshot API 浣跨敤 OpenAI 鍏煎鏍煎紡锛岃璇佹柟寮忎篃鏄?Bearer Token
        this.axiosInstance = axios.create({
            timeout: DEFAULT_TIMEOUT,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // 璇锋眰鎷︽埅鍣細娣诲姞璁よ瘉淇℃伅
        // Moonshot API 浣跨敤 Bearer Token 璁よ瘉锛屾牸寮忥細Authorization: Bearer <api_key>
        this.axiosInstance.interceptors.request.use(
            (config) => {
                if (this.config?.apiKey) {
                    // Moonshot API 浣跨敤鏍囧噯鐨?Bearer Token 璁よ瘉
                    // 鍙傝€冿細https://platform.moonshot.cn/docs/guide/start-using-kimi-api
                    config.headers.Authorization = `Bearer ${this.config.apiKey}`;
                }
                return config;
            },
            (error) => Promise.reject(error)
        );
        
        // 鍝嶅簲鎷︽埅鍣細缁熶竴閿欒澶勭悊
        this.axiosInstance.interceptors.response.use(
            (response) => response,
            (error: AxiosError) => {
                this.logger.error(`AI API璋冪敤澶辫触: ${error.message}`);
                if (error.response?.status === 404) {
                    const body = error.response?.data as { error?: { message?: string; type?: string } } | undefined;
                    const msg = body?.error?.message ?? '';
                    this.logger.warn(`404 鍙兘鍘熷洜锛氣憼 妯″瀷涓嶅瓨鍦ㄦ垨鏃犳潈闄愶紙鍘傚晢鏂囨。锛?04 = 涓嶅瓨鍦ㄨ model 鎴?Permission denied锛夆憽 绔偣鍦板潃閿欒銆傚綋鍓嶄娇鐢?model 瑙佷笂鏂规棩蹇椼€傚搷搴? ${msg || JSON.stringify(body ?? '')}`);
                }
                return Promise.reject(error);
            }
        );
    }

    /**
     * 鍒濆鍖朅I瀹℃煡鍣?     * 浠嶤onfigManager鍔犺浇AI瀹℃煡閰嶇疆
     */
    async initialize(): Promise<void> {
        const config = this.configManager.getConfig();
        if (!config.ai_review) {
            this.config = null;
            return;
        }

        // 杞崲閰嶇疆鏍煎紡锛汷penAI 鍏煎鏍煎紡涓嬭嫢鍙～浜?base URL锛堝 https://api.moonshot.cn/v1锛夛紝鑷姩琛ュ叏 /chat/completions锛屼笌瀹樻柟鏂囨。涓€鑷?
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

        // 鏇存柊axios瀹炰緥鐨勮秴鏃舵椂闂?
        this.axiosInstance.defaults.timeout = this.config.timeout;

        const ep = this.config.apiEndpoint || '';
        const endpointResolved = !!ep && !ep.includes('${');
        if (ep && !endpointResolved) {
            this.logger.warn(`[绔偣鏈В鏋怾 浠嶅惈鍗犱綅绗︼紝璇锋鏌?.env 鎴栬缃腑鐨勭幆澧冨彉閲? ${ep.substring(0, 60)}${ep.length > 60 ? '...' : ''}`);
        }
        // 妫€鏌ュ叧閿厤缃?
        if (!ep) {
            this.logger.warn('⚠️ AI API端点未配置，AI审查将无法执行');
        }
        // 妫€鏌?apiKey 鏄惁閰嶇疆涓斿凡姝ｇ‘瑙ｆ瀽锛堜笉鏄幆澧冨彉閲忓崰浣嶇锛?
        if (!this.config.apiKey) {
            this.logger.warn('鈿狅笍 AI API瀵嗛挜鏈厤缃紝鍙兘瀵艰嚧璁よ瘉澶辫触');
        } else if (this.config.apiKey.startsWith('${') && this.config.apiKey.endsWith('}')) {
            this.logger.warn(`鈿狅笍 AI API瀵嗛挜鐜鍙橀噺鏈В鏋? ${this.config.apiKey}`);
            this.logger.warn('璇风‘淇濊缃簡 OPENAI_API_KEY 鐜鍙橀噺锛屾垨鍦ㄩ」鐩牴鐩綍鍒涘缓 .env 鏂囦欢');
        }
    }

    /**
     * 鎵цAI瀹℃煡
     *
     * 褰?request.diffByFile 瀛樺湪涓旈厤缃?diff_only 鍚敤鏃讹紝浠呭彂閫佸彉鏇寸墖娈碉紱
     * 褰?request.astSnippetsByFile 瀛樺湪鏃讹紝浼樺厛鍙戦€?AST 鐗囨銆傝繑鍥炵殑 line 鍧囦负鏂版枃浠惰鍙枫€?     * 褰?request.diagnosticsByFile 瀛樺湪鏃讹紝浼氬皢鍏朵綔涓恒€屽凡鐭ラ棶棰樼櫧鍚嶅崟銆嶆敞鍏ユ彁绀鸿瘝锛屽苟鍦ㄧ粨鏋滃悗缃繃婊ら噸澶嶉棶棰樸€?     *
     * @param request - 瀹℃煡璇锋眰锛涘彲鍚?diffByFile 鐢ㄤ簬澧為噺瀹℃煡
     * @returns 瀹℃煡闂鍒楄〃
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

        // 鍐冲畾瀹℃煡鑼冨洿锛氫粎鍙樻洿(diff)銆佷粎 AST 鐗囨銆佹垨鏁存枃浠?
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
        // 鑻ヤ负 diff/AST 妯″紡锛氫负姣忎釜鏂囦欢鏋勫缓瑕佸彂閫佺殑鍐呭锛堢墖娈?+ 鍙€?LSP 涓婁笅鏂囷級锛涘惁鍒欐部鐢ㄨ姹備腑鐨勬枃浠跺垪琛?
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

        // ---------- 鏋勫缓銆屽厑璁告姤鍛婇棶棰樼殑琛屻€嶉泦鍚堬紙diff/AST 妯″紡涓嬪彧鎺ュ彈杩欎簺琛屼笂鐨?issue锛岄伩鍏嶆ā鍨嬬寽鏈彂閫佽锛?---------
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

        // ---------- 鍔犺浇鏂囦欢鍐呭銆侀瑙堟ā寮忕煭璺€佹瀯寤哄鏌ュ崟鍏冧笌鎵规 ----------
        try {
            const previewOnly = astConfig?.preview_only === true;
            if (previewOnly) {
                this.logger.info('[ast.preview_only=true] 浠呴瑙堝垏鐗囷紝涓嶈姹傚ぇ妯″瀷');
            }
            const validFiles = await this.loadFilesWithContent(filesToLoad, previewOnly);
            if (validFiles.length === 0) {
                this.logger.warn('娌℃湁鍙鏌ョ殑鏂囦欢');
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

            // 灏嗐€屽甫鍐呭鐨勬枃浠躲€嶆墦鎴愬鏌ュ崟鍏冿紙鎸?batching_mode 鍙兘鎸夋枃浠舵垨鎸?AST snippet 鎷嗗垎锛?
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

            // 鎸夐厤缃€夋嫨鎵规绛栫暐锛歛st_snippet 鎸夌墖娈甸绠楀垏鎵癸紝鍚﹀垯鎸夋枃浠舵暟閲忓垏鎵?
            const useAstSnippetBatching = useAstSnippets && this.config?.batching_mode === 'ast_snippet';
            const batches = useAstSnippetBatching
                ? splitUnitsBySnippetBudget(reviewUnits, getAstSnippetBudget(this.config))
                : splitIntoBatches(reviewUnits, DEFAULT_BATCH_SIZE);

            // 鎵撶偣锛氭湰娆″鏌ョ殑鏂囦欢鏁般€佸崟鍏冩暟銆佹壒娆℃暟銆佸苟鍙戜笌棰勭畻锛屼究浜庢帓鏌ヤ笌璋冧紭
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
            const clipped = joined.length > 4000 ? `${joined.slice(0, 4000)}\n...（已截断）` : joined;
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
     * 纭繚閰嶇疆宸插垵濮嬪寲
     * 姣忔瀹℃煡鍓嶉噸鏂板姞杞介厤缃紝浠ヤ究璇诲彇鏈€鏂扮殑 .env 鍜?VSCode 璁剧疆
     */
    private async ensureInitialized(): Promise<void> {
        await this.configManager.loadConfig();
        await this.initialize();
    }

    /** 妫€鏌?AI 閰嶇疆鏄惁鏈夋晥锛堝瓨鍦ㄣ€佸惎鐢ㄣ€佺鐐?妯″瀷鍙В鏋愩€丄PI Key 宸叉彁绀猴級 */
    private isConfigValid(): boolean {
        if (!this.config) {
            this.logger.warn('AI瀹℃煡閰嶇疆涓嶅瓨鍦紝璺宠繃AI瀹℃煡');
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
                    ? 'AI API端点环境变量未解析，请检查 .env 或系统环境变量'
                    : 'AI API端点未配置'
            );
            return false;
        }
        try {
            new URL(ep);
        } catch {
            this.logger.warn('AI API绔偣URL鏍煎紡鏃犳晥');
            return false;
        }
        const model = (this.config.model || '').trim();
        if (!model || model.includes('${')) {
            this.logger.warn(
                model.includes('${')
                    ? 'AI 模型环境变量未解析'
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
     * 妫€鏌ユ槸鍚︽湁鏈夋晥鐨?API 瀵嗛挜
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
     * 鏍规嵁 FileDiff 鏋勫缓甯﹁鍙锋爣娉ㄧ殑鍙樻洿鐗囨锛屼緵 AI 瀹℃煡浣跨敤
     * 杩斿洖鏍煎紡鍚?"# 琛?N"锛屼究浜?AI 杩斿洖姝ｇ‘鐨勬柊鏂囦欢琛屽彿
     */
    /**
     * 鏋勯€犵粨鏋勫寲瀹℃煡鍐呭锛氭樉寮忓尯鍒嗗綋鍓嶅鏌ョ墖娈典笌澶栭儴鍙傝€冧笂涓嬫枃銆?     *
     * 杩欐牱鍙互鍦ㄦ彁绀鸿瘝灞傞潰闄嶄綆鈥滃閮ㄧ鍙锋湭瀹氫箟鈥濈被璇姤銆?     */
    /**
     * 鍔犺浇鏂囦欢鍐呭
     *
     * @param files - 鏂囦欢鍒楄〃锛堝彲鑳藉彧鏈夎矾寰勬垨宸插甫 content 鐨?diff 鐗囨锛?     * @returns 鍖呭惈鍐呭鐨勬枃浠跺垪琛?     */
    private async loadFilesWithContent(
        files: Array<{ path: string; content?: string }>,
        previewOnly = false
    ): Promise<Array<{ path: string; content: string }>> {
        const filesWithContent = await Promise.all(
            files.map(async (file) => {
                // 濡傛灉鏂囦欢宸叉湁鍐呭涓斾笉涓虹┖锛岀洿鎺ヤ娇鐢紙diff/AST 妯″紡涓嬩负鍙樻洿鐗囨锛?
                // 娉ㄦ剰锛氬鏋?content 鏄┖瀛楃涓诧紝涔熼渶瑕佽鍙栨枃浠?
                if (file.content !== undefined && file.content.trim().length > 0) {
                    return { path: file.path, content: file.content };
                }
                // 鍚﹀垯璇诲彇鏁存枃浠讹紙diff 妯″紡涓嬩笉搴旇蛋鍒拌繖閲岋紝鑻ヨ蛋鍒拌鏄庤鏂囦欢鏈尮閰嶅埌 diff锛?
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

    /** 骞跺彂鎵ц澶氭壒瀹℃煡锛氱敤鍥哄畾鏁伴噺鐨?worker 杞祦鍙栨壒娆′笅鏍囷紝鍚勮嚜璋冪敤 processSingleReviewBatch锛屾渶鍚庡悎骞剁粨鏋?*/
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

        // 澶氫釜 worker 骞跺彂锛氭瘡涓惊鐜彇涓€涓?batch 涓嬫爣锛屾墽琛屽畬鍐嶅彇涓嬩竴涓紝鐩村埌娌℃湁鏇村鎵规
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
        // 鎵撶偣锛氭暣涓苟鍙戞睜鑰楁椂銆佹壒娆℃暟銆佸苟鍙戞暟
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
                this.logger.warn(`鎵瑰鐞嗛噸澶嶅鏌ュ崟鍏冨凡璺宠繃: ${unit.unitId}`);
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
            this.logger.warn(`[batch_guard] 鎵规浼扮畻闀垮害 ${estimatedChars} 瓒呰繃涓婇檺 ${maxRequestChars}锛屽皢浜屽垎闄嶈浇`);
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

    /** 鍒ゆ柇鏄惁涓轰笂涓嬫枃瓒呴暱绫婚敊璇紙413 鎴?400+鐩稿叧娑堟伅锛?*/
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

    /** 澶勭悊瀹℃煡閿欒锛歜lock_commit 鏃舵姏鍑猴紝鍚﹀垯杩斿洖鍗曟潯 issue */
    private handleReviewError(error: unknown): ReviewIssue[] {
        this.logger.error('AI瀹℃煡澶辫触', error);
        const action = this.config?.action ?? 'warning';
        const message = error instanceof Error ? error.message : String(error);
        const isTimeout = axios.isAxiosError(error) && (error.code === 'ECONNABORTED' || /timeout/i.test(error.message));
        const userMessage = isTimeout
            ? `AI审查超时（${this.config?.timeout ?? DEFAULT_TIMEOUT}ms），请稍后重试`
            : `AI瀹℃煡澶辫触: ${message}`;
        const rule = isTimeout ? 'ai_review_timeout' : 'ai_review_error';

        if (action === 'block_commit') throw new Error(userMessage);
        return [{ file: '', line: 1, column: 1, message: userMessage, rule, severity: actionToSeverity(action) }];
    }

    /**
     * 閲嶇疆瀹℃煡缂撳瓨
     * 鍙湪鍗曟瀹℃煡鐢熷懡鍛ㄦ湡鍐呭鐢ㄧ紦瀛橈紝閬垮厤璺ㄥ鏌ユ薄鏌撶粨鏋?     */
    private resetReviewCache = (): void => {
        this.baseMessageCache.clear();
    };

    /**
     * 璋冪敤AI API
     *
     * @param request - 瀹℃煡璇锋眰锛堟枃浠跺繀椤诲寘鍚?content锛?     * @param options - isDiffContent 涓?true 鏃舵彁绀鸿瘝涓鏄庝粎瀹℃煡鍙樻洿涓?line 涓烘柊鏂囦欢琛屽彿
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
            throw new Error('AI瀹℃煡閰嶇疆鏈垵濮嬪寲');
        }
        const url = (this.config.apiEndpoint || '').trim();
        if (!url || url.includes('${')) {
            throw new Error('AI API绔偣鏈厤缃垨鐜鍙橀噺鏈В鏋愶紝璇峰湪 .env 涓缃?AGENTREVIEW_AI_API_ENDPOINT 鎴栧湪璁剧疆涓～鍐欏畬鏁?URL');
        }
        try {
            new URL(url);
        } catch {
            throw new Error(`AI API绔偣URL鏃犳晥: ${url.substring(0, 60)}${url.length > 60 ? '...' : ''}`);
        }

        const requestHash = this.calculateRequestHash(request);
        const projectRulesSummary = await this.configManager.getProjectRulesSummary();

        const requestBody = this.config.api_format === 'custom'
            ? buildCustomRequest(request)
            : buildOpenAIRequest(this.config, request, {
                isDiffContent: options?.isDiffContent,
                diagnosticsByFile: options?.diagnosticsByFile,
                projectRulesSummary,
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

                this.logger.warn('AI鍝嶅簲鐤戜技琚埅鏂紝灏濊瘯缁啓琛ュ叏');

                if (attempt === maxRetries) {
                    this.logger.warn('缁啓閲嶈瘯娆℃暟宸茬敤灏斤紝杩斿洖宸茶В鏋愮殑閮ㄥ垎缁撴灉');
                    logCallSummary(attempt + 1, true);
                    return mergedResponse;
                }

                const baseMessages = this.baseMessageCache.get(requestHash);
                if (!baseMessages) {
                    this.logger.warn('缁啓澶辫触锛氭湭鎵惧埌鍩虹鎻愮ず璇嶏紝杩斿洖宸茶В鏋愮殑閮ㄥ垎缁撴灉');
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
                
                // 濡傛灉鏄渶鍚庝竴娆″皾璇曪紝鐩存帴鎶涘嚭閿欒
                if (attempt === maxRetries) {
                    break;
                }

                // 鍒ゆ柇鏄惁搴旇閲嶈瘯
                if (this.shouldRetry(error as AxiosError)) {
                    const delay = baseDelay * Math.pow(2, attempt);
                    this.logger.warn(`AI API璋冪敤澶辫触锛?{delay}ms鍚庨噸璇?(${attempt + 1}/${maxRetries})`);
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
                    // 涓嶅簲璇ラ噸璇曠殑閿欒锛堝401璁よ瘉澶辫触锛夛紝鐩存帴鎶涘嚭
                    throw error;
                }
            }
        }

        // 鎵€鏈夐噸璇曢兘澶辫触锛屾姏鍑烘渶鍚庝竴涓敊璇?
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
        throw new Error(`AI API璋冪敤澶辫触锛堝凡閲嶈瘯${maxRetries}娆★級: ${lastError?.message || '鏈煡閿欒'}`);
    }


    /**
     * 鐢熸垚璇锋眰鍝堝笇锛岀敤浜庣紦瀛樹笌缁啓鍏宠仈
     * 
     * 閫氳繃鏂囦欢璺緞涓庡唴瀹圭敓鎴愮ǔ瀹氬搱甯岋紝纭繚鍚屾壒娆¤姹傚彲澶嶇敤缂撳瓨
     */
    private calculateRequestHash = (request: { files: Array<{ path: string; content: string }> }): string => {
        const raw = request.files
            .map(file => `${file.path}:${file.content}`)
            .join('|');
        return this.simpleHash(raw);
    };

    /**
     * 绠€鍗曞瓧绗︿覆鍝堝笇
     * 
     * 閬垮厤寮曞叆棰濆渚濊禆锛屾弧瓒崇紦瀛橀敭鐨勭ǔ瀹氭€ч渶姹?     */
    private simpleHash = (input: string): string => {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            hash = (hash << 5) - hash + input.charCodeAt(i);
            hash |= 0;
        }
        return `${hash}`;
    };

    /**
     * 鍚堝苟骞跺幓閲嶇紦瀛橀棶棰?     * 
     * 鐢ㄤ簬缁啓鍦烘櫙锛屽皢宸茶В鏋愮殑闂涓庣画鍐欑粨鏋滃悎骞?     */
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
     * 鍘婚噸 issues锛岄伩鍏嶇画鍐欏甫鏉ョ殑閲嶅缁撴灉
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

    /** 鏄惁搴旈噸璇曪細鏃犲搷搴?缃戠粶/瓒呮椂)銆?xx銆?29 鍙噸璇曪紱鍏朵綑(401/400绛?涓嶉噸璇?*/
    private shouldRetry(error: AxiosError): boolean {
        if (!error.response) return true;
        const status = error.response.status;
        return status >= 500 || status === 429;
    }

    /**
     * 灏嗛噸璇曞師鍥犲綊涓€鍖栦负鍙垎鏋愬瓧娈碉紝渚夸簬鍚庣画缁熻璋冪敤澶辫触鍒嗗竷
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

    /**
     * 寤惰繜鍑芥暟
     * 
     * @param ms - 寤惰繜姣鏁?     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

