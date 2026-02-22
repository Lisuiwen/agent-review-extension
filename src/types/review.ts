/**
 * 瀹℃煡鐩稿叧绫诲瀷瀹氫箟
 *
 * 闆嗕腑缁存姢 ReviewIssue銆丷eviewResult 绛夛紝渚?core銆乽i銆乧ommands 绛夋ā鍧楀紩鐢ㄣ€?
 */

/**
 * 瀹℃煡闂鎺ュ彛
 * 鎻忚堪涓€涓叿浣撶殑浠ｇ爜闂锛屽寘鍚綅缃€佹秷鎭€佽鍒欑瓑淇℃伅
 */
export interface ReviewIssue {
    workspaceRoot?: string;     // 问题所属项目根路径（多根聚合时用于归属）
    file: string;              // 鏂囦欢璺緞
    line: number;              // 闂鎵€鍦ㄨ鍙凤紙浠?寮€濮嬶級
    column: number;            // 闂鎵€鍦ㄥ垪鍙凤紙浠?寮€濮嬶級
    message: string;            // 闂鎻忚堪娑堟伅
    reason?: string;            // 闂鍘熷洜璇存槑锛堝彲閫夛紝浼樺厛鐢ㄤ簬璇︽儏娴眰锛?
    rule: string;               // 瑙﹀彂鐨勮鍒欏悕绉帮紙濡?'no_space_in_filename'锛?
    severity: 'error' | 'warning' | 'info';  // 涓ラ噸绋嬪害
    astRange?: { startLine: number; endLine: number }; // AST 鐗囨鑼冨洿锛?-based锛屽彲閫夛級
    /** 閫佺粰 AI 鐨勫叧鑱斾笂涓嬫枃琛屽彿锛堜粎琛屽彿锛屼緵 hover 鎶樺彔灞曠ず锛氫緷璧栧畾涔夈€佽皟鐢ㄦ柟銆佸悓涓€ SFC 鍧楄寖鍥达級 */
    contextLineRefs?: {
        definitions?: Array<{ file: string; line: number }>;
        usages?: Array<{ file: string; line: number }>;
        vueRelatedBlock?: { template?: [number, number]; script?: [number, number] };
    };
    /** 鍐呭瀵诲潃鎸囩汗锛岀敤浜庨」鐩骇蹇界暐锛堟姉琛屽彿鍋忕Щ锛夛紱瑙?utils/issueFingerprint.ts */
    fingerprint?: string;
    ignored?: boolean;          // 鏄惁琚?@ai-ignore 瑕嗙洊锛堜粎鐢ㄤ簬褰撳墠闈㈡澘灞曠ず鎬侊級
    ignoreReason?: string;      // 鏀捐鍘熷洜锛堜粠 @ai-ignore 娉ㄩ噴涓彁鍙栵紝鍙€夛級
    stale?: boolean;            // 浣嶇疆宸插悓姝ヤ絾璇箟寰呭瀹★紙缂栬緫鏈熸湰鍦伴噸鏄犲皠鍚庢爣璁帮級
}

/**
 * 瀹℃煡缁撴灉鎺ュ彛
 * 鍖呭惈瀹℃煡鏄惁閫氳繃锛屼互鍙婃寜涓ラ噸绋嬪害鍒嗙被鐨勯棶棰樺垪琛?
 */
export interface ReviewResult {
    passed: boolean;           // 瀹℃煡鏄惁閫氳繃锛坱rue=閫氳繃锛宖alse=鏈€氳繃锛?
    errors: ReviewIssue[];     // 閿欒绾у埆鐨勯棶棰橈紙浼氶樆姝㈡彁浜わ級
    warnings: ReviewIssue[];   // 璀﹀憡绾у埆鐨勯棶棰橈紙涓嶄細闃绘鎻愪氦锛?
    info: ReviewIssue[];       // 淇℃伅绾у埆鐨勯棶棰橈紙浠呰褰曪級
}

