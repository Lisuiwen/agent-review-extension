/**
 * 行号重映射模块：根据「旧版本 → 新版本」的 diff 变更，把旧文件中的行号映射到新文件中的行号。
 * 用于在代码发生增删后，仍能正确高亮或定位到「逻辑上同一行」在新文件中的位置。
 */

/** 单段 diff 变更（与 unified diff 的 hunk 概念一致，行号均为 1-based） */
export interface LineMappingChange {
    /** 变更在旧文件中的起始行（含） */
    startLine1: number;
    /** 变更在旧文件中的结束行（含） */
    endLine1: number;
    /** 新文件中新增的行数 */
    added: number;
    /** 旧文件中删除的行数 */
    removed: number;
}

type RebaseOptions = {
    /** 新文件最大行号，映射结果会被 clamp 到 [1, maxLine] */
    maxLine?: number;
};

export type RebasedIssuePosition = {
    line: number;
    astRange?: { startLine: number; endLine: number };
    diagnostics: {
        lineClamped: boolean;
        rangeClamped: boolean;
        lineChanged: boolean;
        rangeChanged: boolean;
    };
};

/**
 * 将行号规范到合法范围：≥1 的整数，且不超过 maxLine（若提供）。
 * 用于避免非法行号导致高亮或编辑器 API 出错。
 */
const clampLine = (line: number, maxLine?: number): number => {
    const normalized = Math.max(1, Math.floor(line));
    if (typeof maxLine === 'number' && Number.isFinite(maxLine) && maxLine > 0) {
        return Math.min(normalized, Math.floor(maxLine));
    }
    return normalized;
};

/**
 * 规范化并排序变更列表：保证每段变更合法、按 startLine1 升序，
 * 便于按「从文件顶部到底部」顺序累计偏移并做二分判断。
 */
type NormalizedLineMappingChange = LineMappingChange & { order: number };

const normalizeChanges = (changes: LineMappingChange[]): NormalizedLineMappingChange[] => {
    return [...changes]
        .map((change, index) => {
            const startLine1 = clampLine(change.startLine1);
            const endLine1 = Math.max(startLine1, clampLine(change.endLine1));
            const added = Math.max(0, Math.floor(change.added));
            const removed = Math.max(0, Math.floor(change.removed));
            return { startLine1, endLine1, added, removed, order: index };
        })
        .sort((a, b) =>
            a.startLine1 === b.startLine1
                ? a.order - b.order
                : a.startLine1 - b.startLine1
        );
};

/**
 * 根据多段内容变更，将「旧文件中的行号」映射为「新文件中的行号」。
 *
 * 逻辑简述：
 * 1. 按 startLine1 顺序遍历每段变更，维护累计偏移 offset（前面所有变更的 added - removed 之和）。
 * 2. 若 sourceLine > change.endLine1：当前变更整体在 sourceLine 之上，只累加 delta 到 offset，继续下一段。
 * 3. 若 sourceLine < change.startLine1：当前变更在 sourceLine 之下，后面变更更靠下，直接结束循环，返回 sourceLine + offset。
 * 4. 若 sourceLine 落在 [startLine1, endLine1] 内（即命中当前变更）：
 *    - 纯插入（removed=0, added>0）且 sourceLine === startLine1：旧文件该行对应新文件中「插入块之后」的那一行，即 startLine1 + offset + added。
 *    - 其他情况（有删除或命中变更中间）：旧行区间被整体替换/收缩，统一映射到新文件中该变更的起始行：startLine1 + offset。
 * 5. 若遍历完所有变更仍未 return，说明 sourceLine 在所有变更之下，返回 sourceLine + offset。
 *
 * @param line 旧文件中的 1-based 行号
 * @param changes 多段 diff 变更（通常来自解析 unified diff）
 * @param options 可选，如 maxLine 限制映射结果上限
 * @returns 新文件中的 1-based 行号
 */
export const rebaseLineByContentChanges = (
    line: number,
    changes: LineMappingChange[],
    options?: RebaseOptions
): number => {
    let currentLine = clampLine(line);
    const normalizedChanges = normalizeChanges(changes);
    for (const change of normalizedChanges) {
        const delta = change.added - change.removed;
        const isPureInsert = change.removed === 0 && change.added > 0;
        if (currentLine > change.endLine1) {
            currentLine += delta;
            continue;
        }
        if (currentLine < change.startLine1) {
            break;
        }
        if (isPureInsert && currentLine === change.startLine1) {
            currentLine += change.added;
            continue;
        }
        currentLine = change.startLine1;
    }
    return clampLine(currentLine, options?.maxLine);
};

/**
 * 对「行范围」做重映射：分别映射 startLine、endLine，再保证返回的 start ≤ end
 *（因多段变更后起止行可能相对顺序与旧文件不同，故取 min/max）。
 */
export const rebaseRangeByContentChanges = (
    range: { startLine: number; endLine: number },
    changes: LineMappingChange[],
    options?: RebaseOptions
): { startLine: number; endLine: number } => {
    const rebasedStart = rebaseLineByContentChanges(range.startLine, changes, options);
    const rebasedEnd = rebaseLineByContentChanges(range.endLine, changes, options);
    return {
        startLine: Math.min(rebasedStart, rebasedEnd),
        endLine: Math.max(rebasedStart, rebasedEnd),
    };
};

/**
 * 同时重映射 issue 的 line 与 astRange，并返回合法性诊断信息。
 * 该函数用于 UI 层在“是否允许精确高亮”前做置信度评估。
 */
export const rebaseIssuePositionByContentChanges = (
    source: { line: number; astRange?: { startLine: number; endLine: number } },
    changes: LineMappingChange[],
    options?: RebaseOptions
): RebasedIssuePosition => {
    const rawLine = rebaseLineByContentChanges(source.line, changes);
    const line = rebaseLineByContentChanges(source.line, changes, options);
    const rawRange = source.astRange
        ? rebaseRangeByContentChanges(source.astRange, changes)
        : undefined;
    const astRange = source.astRange
        ? rebaseRangeByContentChanges(source.astRange, changes, options)
        : undefined;
    return {
        line,
        astRange,
        diagnostics: {
            lineClamped: line !== rawLine,
            rangeClamped: !!rawRange && !!astRange
                && (rawRange.startLine !== astRange.startLine || rawRange.endLine !== astRange.endLine),
            lineChanged: line !== clampLine(source.line, options?.maxLine),
            rangeChanged: !!source.astRange && !!astRange
                && (
                    clampLine(source.astRange.startLine, options?.maxLine) !== astRange.startLine
                    || clampLine(source.astRange.endLine, options?.maxLine) !== astRange.endLine
                ),
        },
    };
};
