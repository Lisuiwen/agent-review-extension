/**
 * ReviewPanelProvider 增量/来源分栏单元测试（Vitest）
 * 验证规则检测与 AI 检测分组、空状态提示、忽略后计数更新等。
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

const createResult = (): ReviewResult => ({
    passed: false,
    errors: [{
        file: 'src/rule.ts',
        line: 3,
        column: 1,
        message: '规则错误',
        rule: 'no_todo',
        severity: 'error',
    }],
    warnings: [{
        file: 'src/ai.ts',
        line: 10,
        column: 1,
        message: 'AI警告',
        rule: 'ai_review',
        severity: 'warning',
    }],
    info: [],
});

describe('ReviewPanelProvider 来源分栏', () => {
    it('根节点应出现规则检测错误与AI检测错误两个分组', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createResult(), 'completed');

        const labels = provider.getChildren().map(item => item.label);
        expect(labels.some(label => label.includes('审查未通过'))).toBe(true);
        expect(labels.some(label => label.includes('规则检测错误'))).toBe(true);
        expect(labels.some(label => label.includes('AI检测错误'))).toBe(true);
    });

    it('分组节点应按来源展示文件与问题', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createResult(), 'completed');

        const groupNodes = provider.getChildren().filter(item => item.groupKey);
        const ruleGroup = groupNodes.find(item => item.groupKey === 'rule');
        const aiGroup = groupNodes.find(item => item.groupKey === 'ai');
        expect(ruleGroup).toBeDefined();
        expect(aiGroup).toBeDefined();

        const ruleFiles = provider.getChildren(ruleGroup);
        expect(ruleFiles.length).toBe(1);
        expect(ruleFiles[0].filePath).toBe('src/rule.ts');

        const aiFiles = provider.getChildren(aiGroup);
        expect(aiFiles.length).toBe(1);
        expect(aiFiles[0].filePath).toBe('src/ai.ts');

        const ruleIssues = provider.getChildren(ruleFiles[0]);
        const aiIssues = provider.getChildren(aiFiles[0]);
        expect(ruleIssues.length).toBe(1);
        expect(aiIssues.length).toBe(1);
        expect(ruleIssues[0].issue?.rule).toBe('no_todo');
        expect(aiIssues[0].issue?.rule).toBe('ai_review');
    });

    it('分组数量应正确反映结果中的规则与 AI 问题', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createResult(), 'completed');

        const labels = provider.getChildren().map(item => item.label);
        expect(labels.some(label => label.includes('规则检测错误 (1)'))).toBe(true);
        expect(labels.some(label => label.includes('AI检测错误 (1)'))).toBe(true);
    });

    it('无问题时应优先展示场景化 emptyStateHint', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(
            {
                passed: true,
                errors: [],
                warnings: [],
                info: [],
            },
            'completed',
            '',
            '当前保存文件复审未发现问题'
        );

        const labels = provider.getChildren().map(item => item.label);
        expect(labels.some(label => label.includes('当前保存文件复审未发现问题'))).toBe(true);
        expect(labels.some(label => label.includes('没有staged文件需要审查'))).toBe(false);
    });

    it('忽略移除问题后应同步更新根节点分组数量', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createResult(), 'completed');

        const before = provider.getChildren().map(item => item.label);
        expect(before.some(label => label.includes('规则检测错误 (1)'))).toBe(true);

        provider.removeIssue({
            file: 'src/rule.ts',
            line: 3,
            column: 1,
            message: '规则错误',
            rule: 'no_todo',
            severity: 'error',
        });

        const after = provider.getChildren().map(item => item.label);
        expect(after.some(label => label.includes('规则检测错误 (0)'))).toBe(true);
    });
});
