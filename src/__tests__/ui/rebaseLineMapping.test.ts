import { describe, expect, it } from 'vitest';
import {
    rebaseLineByContentChanges,
    rebaseIssuePositionByContentChanges,
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

    it('同一起始行插入后删除组合应按事件顺序重放', () => {
        const issueLine = 10;
        const changes: LineMappingChange[] = [
            { startLine1: 10, endLine1: 10, added: 2, removed: 0 },
            { startLine1: 10, endLine1: 12, added: 0, removed: 2 },
        ];

        const mapped = rebaseLineByContentChanges(issueLine, changes);

        // 先插入两行再删除两行，目标应回到原始锚点行
        expect(mapped).toBe(10);
    });

    it('纯插入在问题行之前应按新增行数下移', () => {
        const issueLine = 20;
        const changes: LineMappingChange[] = [
            { startLine1: 6, endLine1: 6, added: 3, removed: 0 },
        ];

        const mapped = rebaseLineByContentChanges(issueLine, changes);

        expect(mapped).toBe(23);
    });

    it('问题行落在删除区间内时应映射到区间起始行', () => {
        const issueLine = 9;
        const changes: LineMappingChange[] = [
            { startLine1: 8, endLine1: 11, added: 0, removed: 3 },
        ];

        const mapped = rebaseLineByContentChanges(issueLine, changes, { maxLine: 30 });

        expect(mapped).toBe(8);
    });

    it('line/astRange 重映射后应返回合法性诊断信息', () => {
        const changes: LineMappingChange[] = [];
        const rebased = rebaseIssuePositionByContentChanges(
            {
                line: 20,
                astRange: { startLine: 19, endLine: 24 },
            },
            changes,
            { maxLine: 3 }
        );

        expect(rebased.line).toBeGreaterThanOrEqual(1);
        expect(rebased.line).toBeLessThanOrEqual(3);
        expect(rebased.astRange?.startLine).toBeLessThanOrEqual(rebased.astRange?.endLine ?? 0);
        expect(rebased.diagnostics.lineClamped).toBe(true);
        expect(rebased.diagnostics.rangeClamped).toBe(true);
    });
});
