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
        workspaceRoot: 'd:/workspace/project-single',
        file: 'src/rule.ts',
        line: 3,
        column: 1,
        message: '规则错误',
        rule: 'no_todo',
        severity: 'error',
    }],
    warnings: [{
        workspaceRoot: 'd:/workspace/project-single',
        file: 'src/ai.ts',
        line: 10,
        column: 1,
        message: 'AI警告',
        rule: 'ai_review',
        severity: 'warning',
    }],
    info: [],
});

const createMultiRootResult = (): ReviewResult => ({
    passed: false,
    errors: [{
        workspaceRoot: 'd:/workspace/project-a',
        file: 'd:/workspace/project-a/src/a.ts',
        line: 3,
        column: 1,
        message: '规则错误A',
        rule: 'no_todo',
        severity: 'error',
    }],
    warnings: [{
        workspaceRoot: 'd:/workspace/project-b',
        file: 'd:/workspace/project-b/src/b.ts',
        line: 10,
        column: 1,
        message: 'AI警告B',
        rule: 'ai_review',
        severity: 'warning',
    }],
    info: [],
});

describe('ReviewPanelProvider 来源分栏', () => {
    it('根节点应显示状态与项目节点', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createResult(), 'completed');

        const labels = provider.getChildren().map(item => item.label);
        expect(labels.some(label => label.includes('审查未通过'))).toBe(true);
        expect(labels.some(label => label === 'project-single')).toBe(true);
        expect(labels.some(label => label.includes('规则检测错误'))).toBe(false);
        expect(labels.some(label => label.includes('AI检测错误'))).toBe(false);
    });

    it('项目节点下应按来源展示文件与问题', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createResult(), 'completed');

        const projectNode = provider.getChildren().find(item => item.nodeType === 'project');
        expect(projectNode).toBeDefined();

        const groupNodes = provider.getChildren(projectNode);
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

    it('项目内分组数量应正确反映结果中的规则与 AI 问题', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createResult(), 'completed');

        const projectNode = provider.getChildren().find(item => item.nodeType === 'project');
        expect(projectNode).toBeDefined();
        const labels = provider.getChildren(projectNode).map(item => item.label);
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

    it('忽略移除问题后应同步更新项目内分组数量', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createResult(), 'completed');

        const projectNode = provider.getChildren().find(item => item.nodeType === 'project');
        expect(projectNode).toBeDefined();
        const before = provider.getChildren(projectNode).map(item => item.label);
        expect(before.some(label => label.includes('规则检测错误 (1)'))).toBe(true);

        provider.removeIssue({
            file: 'src/rule.ts',
            line: 3,
            column: 1,
            message: '规则错误',
            rule: 'no_todo',
            severity: 'error',
        });

        const after = provider.getChildren(projectNode).map(item => item.label);
        expect(after.some(label => label.includes('规则检测错误 (0)'))).toBe(true);
    });

    it('多根场景顶层应优先展示项目节点，而不是全局规则/AI分组', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult(createMultiRootResult(), 'completed');

        const labels = provider.getChildren().map(item => item.label);
        expect(labels.some(label => label === 'project-a')).toBe(true);
        expect(labels.some(label => label === 'project-b')).toBe(true);
        expect(labels.some(label => label.includes('规则检测错误'))).toBe(false);
        expect(labels.some(label => label.includes('AI检测错误'))).toBe(false);
    });

    it('项目目录名重名时应追加路径后缀，目录名唯一时仅显示目录名', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult({
            passed: false,
            errors: [
                {
                    workspaceRoot: 'd:/workspace/services/a/project-a',
                    file: 'd:/workspace/services/a/project-a/src/a.ts',
                    line: 1,
                    column: 1,
                    message: 'e1',
                    rule: 'no_todo',
                    severity: 'error',
                },
                {
                    workspaceRoot: 'd:/workspace/apps/a/project-a',
                    file: 'd:/workspace/apps/a/project-a/src/b.ts',
                    line: 2,
                    column: 1,
                    message: 'e2',
                    rule: 'no_todo',
                    severity: 'error',
                },
                {
                    workspaceRoot: 'd:/workspace/project-unique',
                    file: 'd:/workspace/project-unique/src/c.ts',
                    line: 3,
                    column: 1,
                    message: 'e3',
                    rule: 'no_todo',
                    severity: 'error',
                },
            ],
            warnings: [],
            info: [],
        }, 'completed');

        const labels = provider.getChildren().map(item => item.label);
        expect(labels.some(label => label === 'project-unique')).toBe(true);
        expect(labels.some(label => label === 'project-a (services/a)')).toBe(true);
        expect(labels.some(label => label === 'project-a (apps/a)')).toBe(true);
    });

    it('跨项目同名文件不串组，且缺失 workspaceRoot 进入未归属项目', () => {
        const provider = new ReviewPanelProvider({} as never);
        provider.updateResult({
            passed: false,
            errors: [
                {
                    workspaceRoot: 'd:/workspace/project-a',
                    file: 'd:/workspace/project-a/src/index.ts',
                    line: 1,
                    column: 1,
                    message: 'a',
                    rule: 'no_todo',
                    severity: 'error',
                },
                {
                    workspaceRoot: 'd:/workspace/project-b',
                    file: 'd:/workspace/project-b/src/index.ts',
                    line: 2,
                    column: 1,
                    message: 'b',
                    rule: 'no_todo',
                    severity: 'error',
                },
                {
                    file: 'd:/workspace/unknown/src/index.ts',
                    line: 3,
                    column: 1,
                    message: 'u',
                    rule: 'no_todo',
                    severity: 'error',
                },
            ],
            warnings: [],
            info: [],
        }, 'completed');

        const rootNodes = provider.getChildren().filter(item => item.nodeType === 'project');
        const projectA = rootNodes.find(item => item.label === 'project-a');
        const projectB = rootNodes.find(item => item.label === 'project-b');
        const unassigned = rootNodes.find(item => item.label === '未归属项目');
        expect(projectA).toBeDefined();
        expect(projectB).toBeDefined();
        expect(unassigned).toBeDefined();

        const projectAGroup = provider.getChildren(projectA).find(item => item.groupKey === 'rule');
        const projectBGroup = provider.getChildren(projectB).find(item => item.groupKey === 'rule');
        expect(projectAGroup).toBeDefined();
        expect(projectBGroup).toBeDefined();

        const projectAFiles = provider.getChildren(projectAGroup).map(item => item.filePath);
        const projectBFiles = provider.getChildren(projectBGroup).map(item => item.filePath);
        expect(projectAFiles).toEqual(['d:/workspace/project-a/src/index.ts']);
        expect(projectBFiles).toEqual(['d:/workspace/project-b/src/index.ts']);
    });
});
