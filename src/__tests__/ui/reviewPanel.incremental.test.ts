import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
    class TreeItem {
        constructor(public label: string, public collapsibleState: number) {}
        public tooltip?: string;
        public description?: string;
        public iconPath?: unknown;
        public command?: unknown;
        public resourceUri?: unknown;
        public contextValue?: string;
    }
    class EventEmitter<T> {
        public event = (_handler: (event: T) => void) => ({ dispose: () => {} });
        public fire = (_event?: T) => {};
        public dispose = () => {};
    }
    class ThemeIcon {
        public static File = new ThemeIcon('file');
        constructor(public id: string, public color?: unknown) {}
    }
    class ThemeColor {
        constructor(public id: string) {}
    }
    class Position {
        constructor(public line: number, public character: number) {}
    }
    class Range {
        constructor(
            public startLine: number,
            public startCharacter: number,
            public endLine: number,
            public endCharacter: number
        ) {}
    }
    return {
        TreeItem,
        EventEmitter,
        ThemeIcon,
        ThemeColor,
        Position,
        Range,
        TreeItemCollapsibleState: {
            None: 0,
            Collapsed: 1,
            Expanded: 2,
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
        },
    };
});

import { ReviewPanelProvider } from '../../ui/reviewPanel';
import type { ReviewResult } from '../../types/review';

const createResult = (): ReviewResult => ({
    passed: false,
    errors: [{
        file: 'src/incremental.ts',
        line: 3,
        column: 1,
        message: '增量错误',
        rule: 'ai_review',
        severity: 'error',
        incremental: true,
    }],
    warnings: [{
        file: 'src/existing.ts',
        line: 10,
        column: 1,
        message: '存量警告',
        rule: 'ai_review',
        severity: 'warning',
        incremental: false,
    }],
    info: [],
});

describe('ReviewPanelProvider 增量/存量分栏', () => {
    it('根节点应出现你的增量与项目存量两个分组', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createResult(), 'completed');

        const root = provider.getChildren();
        const labels = root.map(item => item.label);

        expect(labels.some(label => label.includes('审查未通过'))).toBe(true);
        expect(labels.some(label => label.includes('你的增量'))).toBe(true);
        expect(labels.some(label => label.includes('项目存量'))).toBe(true);
    });

    it('分组节点应只展示本组文件与问题', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createResult(), 'completed');

        const groupNodes = provider.getChildren().filter(item => item.groupKey);
        const incrementalGroup = groupNodes.find(item => item.groupKey === 'incremental');
        const existingGroup = groupNodes.find(item => item.groupKey === 'existing');
        expect(incrementalGroup).toBeDefined();
        expect(existingGroup).toBeDefined();

        const incrementalFiles = provider.getChildren(incrementalGroup);
        expect(incrementalFiles.length).toBe(1);
        expect(incrementalFiles[0].filePath).toBe('src/incremental.ts');

        const existingFiles = provider.getChildren(existingGroup);
        expect(existingFiles.length).toBe(1);
        expect(existingFiles[0].filePath).toBe('src/existing.ts');

        const incrementalIssues = provider.getChildren(incrementalFiles[0]);
        const existingIssues = provider.getChildren(existingFiles[0]);
        expect(incrementalIssues.length).toBe(1);
        expect(existingIssues.length).toBe(1);
        expect(incrementalIssues[0].issue?.incremental).toBe(true);
        expect(existingIssues[0].issue?.incremental).toBe(false);
    });

    it('当存量问题为 0 时，仍应展示“项目存量 (0)”分组', () => {
        const provider = new ReviewPanelProvider({} as never);
        const result: ReviewResult = {
            passed: false,
            errors: [{
                file: 'src/incremental-only.ts',
                line: 1,
                column: 1,
                message: '仅增量问题',
                rule: 'ai_review',
                severity: 'error',
                incremental: true,
            }],
            warnings: [],
            info: [],
        };
        provider.updateResult(result, 'completed');

        const labels = provider.getChildren().map(item => item.label);
        expect(labels.some(label => label.includes('你的增量 (1)'))).toBe(true);
        expect(labels.some(label => label.includes('项目存量 (0)'))).toBe(true);
    });
});
