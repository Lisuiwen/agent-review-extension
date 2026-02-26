export interface LineMappingChange {
    startLine1: number;
    endLine1: number;
    added: number;
    removed: number;
}

type RebaseOptions = {
    maxLine?: number;
};

const clampLine = (line: number, maxLine?: number): number => {
    const normalized = Math.max(1, Math.floor(line));
    if (typeof maxLine === 'number' && Number.isFinite(maxLine) && maxLine > 0) {
        return Math.min(normalized, Math.floor(maxLine));
    }
    return normalized;
};

const normalizeChanges = (changes: LineMappingChange[]): LineMappingChange[] => {
    return [...changes]
        .map((change) => {
            const startLine1 = clampLine(change.startLine1);
            const endLine1 = Math.max(startLine1, clampLine(change.endLine1));
            const added = Math.max(0, Math.floor(change.added));
            const removed = Math.max(0, Math.floor(change.removed));
            return { startLine1, endLine1, added, removed };
        })
        .sort((a, b) =>
            a.startLine1 === b.startLine1
                ? a.endLine1 - b.endLine1
                : a.startLine1 - b.startLine1
        );
};

export const rebaseLineByContentChanges = (
    line: number,
    changes: LineMappingChange[],
    options?: RebaseOptions
): number => {
    const sourceLine = clampLine(line);
    let offset = 0;
    const normalizedChanges = normalizeChanges(changes);
    for (const change of normalizedChanges) {
        const delta = change.added - change.removed;
        const isPureInsert = change.removed === 0 && change.added > 0;
        if (sourceLine > change.endLine1) {
            offset += delta;
            continue;
        }
        if (sourceLine < change.startLine1) {
            break;
        }
        if (isPureInsert && sourceLine === change.startLine1) {
            return clampLine(sourceLine + offset + change.added, options?.maxLine);
        }
        return clampLine(change.startLine1 + offset, options?.maxLine);
    }
    return clampLine(sourceLine + offset, options?.maxLine);
};

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

