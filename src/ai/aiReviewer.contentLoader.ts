/**
 * AI 审查器：文件内容加载
 *
 * 对「路径 + 可选已有内容」的列表，缺失内容的从磁盘读取，供 review 流程使用。
 */

import type { Logger } from '../utils/logger';

type FileScannerLike = { readFile: (path: string) => Promise<string> };

/**
 * 加载文件内容：若条目已有 content 且非空则直接使用，否则从 fileScanner 读取。
 * @param files - 路径与可选内容；content 为空或未提供时从磁盘读
 * @param fileScanner - 用于 readFile(path)
 * @param logger - 用于空文件/读取失败时的 warn
 * @param previewOnly - 为 true 时不对空文件打 warn
 * @returns 仅包含成功得到内容的条目
 */
export const loadFilesWithContent = async (
    files: Array<{ path: string; content?: string }>,
    fileScanner: FileScannerLike,
    logger: Logger,
    previewOnly = false
): Promise<Array<{ path: string; content: string }>> => {
    const loadOne = async (file: { path: string; content?: string }): Promise<{ path: string; content: string } | null> => {
        const hasContent = file.content !== undefined && file.content.trim().length > 0;
        if (hasContent) return { path: file.path, content: file.content! };
        try {
            const content = await fileScanner.readFile(file.path);
            if (!previewOnly && content.length === 0) logger.warn(`文件为空: ${file.path}`);
            return { path: file.path, content };
        } catch (error) {
            logger.warn(`无法读取文件 ${file.path}，跳过`, error);
            return null;
        }
    };
    const results = await Promise.all(files.map(loadOne));
    return results.filter((f): f is { path: string; content: string } => f !== null);
};
