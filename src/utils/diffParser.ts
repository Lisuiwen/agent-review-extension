/**
 * Unified diff 解析器
 *
 * 将 `git diff --cached` 的原始输出解析为结构化的 FileDiff 列表。
 * 仅解析「新文件」侧的行号与内容，供规则引擎与 AI 审查使用。
 */

import { FileDiff, DiffHunk } from './diffTypes';

const GIT_DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+?)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 解析 unified diff 原始文本，得到按文件分组的 FileDiff 列表
 *
 * @param raw - git diff 的完整输出（如 git diff --cached -U3）
 * @returns FileDiff 数组，路径为 b 侧（新文件）路径
 */
export function parseUnifiedDiff(raw: string): FileDiff[] {
    const files: FileDiff[] = [];
    const lines = raw.split(/\r?\n/);
    let i = 0;
    let currentPath: string | null = null;
    let currentHunks: DiffHunk[] = [];
    let currentHunk: { newStart: number; newCount: number; lines: string[] } | null = null;
    let currentAddedLines = 0;
    let currentDeletedLines = 0;
    let currentAddedContentLines: string[] = [];
    let newLineIndex = 0; // 当前 hunk 内「新文件」已处理行数

    const flushHunk = () => {
        if (currentHunk && currentPath) {
            currentHunks.push({
                newStart: currentHunk.newStart,
                newCount: currentHunk.newCount,
                lines: currentHunk.lines,
            });
        }
        currentHunk = null;
        newLineIndex = 0;
    };

    const flushFile = () => {
        if (currentPath && currentHunks.length > 0) {
            files.push({
                path: currentPath,
                hunks: currentHunks,
                addedLines: currentAddedLines,
                deletedLines: currentDeletedLines,
                addedContentLines: currentAddedContentLines,
            });
        }
        currentPath = null;
        currentHunks = [];
        currentAddedLines = 0;
        currentDeletedLines = 0;
        currentAddedContentLines = [];
        flushHunk();
    };

    while (i < lines.length) {
        const line = lines[i];
        const diffMatch = line.match(GIT_DIFF_HEADER);
        const hunkMatch = line.match(HUNK_HEADER);

        if (diffMatch) {
            flushFile();
            // 使用 b 侧路径（新文件）
            currentPath = diffMatch[2].replace(/\\\\/g, '\\');
            i++;
            continue;
        }

        if (hunkMatch) {
            flushHunk();
            const newStart = parseInt(hunkMatch[3], 10);
            const newCount = parseInt(hunkMatch[4] || '1', 10);
            currentHunk = {
                newStart,
                newCount,
                lines: [],
            };
            i++;
            continue;
        }

        if (currentHunk) {
            const prefix = line[0];
            const rest = line.slice(1);
            const isContextOrAdd = prefix === ' ' || prefix === '+';
            if (isContextOrAdd) {
                currentHunk.lines.push(rest);
                newLineIndex++;
            }
            if (prefix === '+') {
                currentAddedLines++;
                currentAddedContentLines.push(rest);
            } else if (prefix === '-') {
                currentDeletedLines++;
            }
            if (newLineIndex >= currentHunk.newCount) flushHunk();
        }

        i++;
    }

    flushFile();
    return files;
}
