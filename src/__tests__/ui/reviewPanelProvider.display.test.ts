/**
 * ReviewPanelProvider 文件节点展示：固定三档严重程度、每文件最多 5 条
 */
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

describe('ReviewPanelProvider 文件节点展示', () => {
    it('文件节点数量固定三档：1 error + 1 warning + 0 info 时 label 含 (1, 1, 0)', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(
            {
                passed: false,
                errors: [{
                    workspaceRoot: 'd:/ws',
                    file: 'src/index.tsx',
                    line: 1,
                    column: 1,
                    message: 'e1',
                    rule: 'r',
                    severity: 'error',
                }],
                warnings: [{
                    workspaceRoot: 'd:/ws',
                    file: 'src/index.tsx',
                    line: 2,
                    column: 1,
                    message: 'w1',
                    rule: 'r',
                    severity: 'warning',
                }],
                info: [],
            },
            'completed'
        );

        const projectNode = provider.getChildren().find(item => item.nodeType === 'project');
        const ruleGroup = projectNode ? provider.getChildren(projectNode).find(item => item.groupKey === 'rule') : undefined;
        const fileItems = ruleGroup ? provider.getChildren(ruleGroup) : [];
        const fileLabel = fileItems.find(item => item.filePath?.endsWith('index.tsx'))?.label ?? '';

        expect(fileLabel).toMatch(/\(1,\s*1,\s*0\)/);
    });

    it('每文件超过 3 条问题时展开子节点仅 3 条且按 severity 优先', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(
            {
                passed: false,
                errors: [
                    { workspaceRoot: 'd:/ws', file: 'src/a.ts', line: 1, column: 1, message: 'e1', rule: 'r', severity: 'error' },
                    { workspaceRoot: 'd:/ws', file: 'src/a.ts', line: 2, column: 1, message: 'e2', rule: 'r', severity: 'error' },
                    { workspaceRoot: 'd:/ws', file: 'src/a.ts', line: 3, column: 1, message: 'e3', rule: 'r', severity: 'error' },
                ],
                warnings: [
                    { workspaceRoot: 'd:/ws', file: 'src/a.ts', line: 4, column: 1, message: 'w1', rule: 'r', severity: 'warning' },
                    { workspaceRoot: 'd:/ws', file: 'src/a.ts', line: 5, column: 1, message: 'w2', rule: 'r', severity: 'warning' },
                ],
                info: [
                    { workspaceRoot: 'd:/ws', file: 'src/a.ts', line: 6, column: 1, message: 'i1', rule: 'r', severity: 'info' },
                    { workspaceRoot: 'd:/ws', file: 'src/a.ts', line: 7, column: 1, message: 'i2', rule: 'r', severity: 'info' },
                ],
            },
            'completed'
        );

        const projectNode = provider.getChildren().find(item => item.nodeType === 'project');
        const ruleGroup = projectNode ? provider.getChildren(projectNode).find(item => item.groupKey === 'rule') : undefined;
        const fileItems = ruleGroup ? provider.getChildren(ruleGroup) : [];
        const fileNode = fileItems.find(item => item.filePath?.endsWith('a.ts'));
        expect(fileNode).toBeDefined();

        const children = fileNode ? provider.getChildren(fileNode) : [];
        expect(children.length).toBe(3);
        const severities = children.map(c => c.issue?.severity);
        expect(severities).toEqual(['error', 'error', 'error']);
    });
});
