/**
 * 审查面板：@ai-ignore 行元数据
 *
 * 从文件中收集被 @ai-ignore 覆盖的行号及放行原因，供 Panel 在忽略后同步行号与状态时使用。
 */

import * as vscode from 'vscode';
import type { IgnoreLineMeta } from './reviewPanel.types';

/**
 * 从文件中收集所有 @ai-ignore 行及注释后首个非空行（与 ReviewEngine.filterIgnoredIssues 一致）。
 */
export const collectIgnoredLineMeta = async (filePath: string): Promise<IgnoreLineMeta> => {
    const meta: IgnoreLineMeta = {
        ignoredLines: new Set<number>(),
        reasonByLine: new Map<number, string>(),
    };
    try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        for (let i = 0; i < document.lineCount; i++) {
            const text = document.lineAt(i).text;
            if (!/@ai-ignore\b/i.test(text)) continue;
            const line = i + 1;
            const reason = extractIgnoreReason(text);
            meta.ignoredLines.add(line);
            if (reason) meta.reasonByLine.set(line, reason);
            let next = i + 1;
            while (next < document.lineCount && document.lineAt(next).text.trim().length === 0) {
                next++;
            }
            if (next < document.lineCount) {
                const nextLine = next + 1;
                meta.ignoredLines.add(nextLine);
                if (reason) meta.reasonByLine.set(nextLine, reason);
            }
        }
    } catch {
        // 文件不存在或无法打开时返回空 meta
    }
    return meta;
};

/** 从行内 @ai-ignore 注释中解析放行原因（冒号或空格后的说明文字） */
export const extractIgnoreReason = (lineText: string): string | undefined => {
    const match = lineText.match(/@ai-ignore(?:\s*:\s*|\s+)?(.*)$/i);
    if (!match) return undefined;
    const cleaned = match[1].replace(/(?:-->\s*|\*\/\s*)$/g, '').trim();
    return cleaned.length > 0 ? cleaned : undefined;
};
