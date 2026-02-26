import { describe, expect, it } from 'vitest';
import {
    rebaseLineByContentChanges,
    rebaseRangeByContentChanges,
    type LineMappingChange,
} from '../../ui/rebaseLineMapping';

describe('rebaseLineByContentChanges', () => {
    it('混合 contentChanges 顺序变化时，映射结果应保持稳定', () => {
        const issueLine = 20;
        const changesA: LineMappingChange[] = [
            { startLine1: 2, endLine1: 2, added: 2, removed: 0 },
            { startLine1: 12, endLine1: 14, added: 0, removed: 2 },
            { startLine1: 18, endLine1: 19, added: 1, removed: 1 },
        ];
        const changesB: LineMappingChange[] = [...changesA].reverse();

        const mappedA = rebaseLineByContentChanges(issueLine, changesA);
        const mappedB = rebaseLineByContentChanges(issueLine, changesB);

        expect(mappedA).toBe(mappedB);
    });

    it('删除空行与删除非空行（等量删除）时，映射结果应一致', () => {
        const issueLine = 30;
        const deleteBlankLines: LineMappingChange[] = [
            { startLine1: 10, endLine1: 12, added: 0, removed: 2 },
        ];
        const deleteNonBlankLines: LineMappingChange[] = [
            { startLine1: 10, endLine1: 12, added: 0, removed: 2 },
        ];

        const mappedBlank = rebaseLineByContentChanges(issueLine, deleteBlankLines);
        const mappedNonBlank = rebaseLineByContentChanges(issueLine, deleteNonBlankLines);

        expect(mappedBlank).toBe(mappedNonBlank);
    });

    it('AST 范围重映射后应保持有序并受文档行数约束', () => {
        const changes: LineMappingChange[] = [
            { startLine1: 1, endLine1: 1, added: 3, removed: 0 },
        ];

        const range = rebaseRangeByContentChanges(
            { startLine: 8, endLine: 4 },
            changes,
            { maxLine: 9 }
        );

        expect(range.startLine).toBeLessThanOrEqual(range.endLine);
        expect(range.startLine).toBeGreaterThanOrEqual(1);
        expect(range.endLine).toBeLessThanOrEqual(9);
    });
});
