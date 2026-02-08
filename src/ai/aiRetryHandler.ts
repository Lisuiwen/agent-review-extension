/**
 * AI 调用重试逻辑
 *
 * 封装带次数与延迟的重试，供 AIReviewer 在单次 API 调用外包裹使用。
 */

export interface RetryOptions {
    maxRetries: number;
    baseDelay: number;
    /** 返回 true 时重试，false 时直接抛出 */
    shouldRetry: (error: unknown) => boolean;
}

const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));

/**
 * 使用指数退避执行异步函数，失败时按 shouldRetry 决定是否重试
 */
export const runWithRetry = async <T>(
    fn: () => Promise<T>,
    options: RetryOptions
): Promise<T> => {
    const { maxRetries, baseDelay, shouldRetry } = options;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt === maxRetries) break;
            if (!shouldRetry(error)) throw error;
            const delay = baseDelay * Math.pow(2, attempt);
            await sleep(delay);
        }
    }
    throw lastError;
};
