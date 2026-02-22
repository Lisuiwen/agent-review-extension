/**
 * ignoreIssueCommand 单元测试
 *
 * 覆盖：无 issue 时提示；error 级别提示不可忽略；warning 时写指纹并 removeIssueFromList。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerIgnoreIssueCommand } from '../../commands/ignoreIssueCommand';
import type { ReviewTreeItem } from '../../ui/reviewPanel';
import type { ReviewIssue } from '../../types/review';
import { addIgnoredFingerprint } from '../../config/ignoreStore';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('vscode', () => ({
    commands: {
        registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(id, handler);
            return { dispose: () => handlers.delete(id) };
        },
    },
    window: {
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
    },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'd:/ws' } }],
        openTextDocument: vi.fn(),
    },
    Uri: { file: (path: string) => ({ fsPath: path }) },
}));

vi.mock('../../config/ignoreStore', () => ({
    addIgnoredFingerprint: vi.fn(async () => {}),
}));

const addIgnoredFingerprintMock = vi.mocked(addIgnoredFingerprint);

describe('ignoreIssueCommand', () => {
    let getActiveIssueForActions: ReturnType<typeof vi.fn>;
    let removeIssueFromList: ReturnType<typeof vi.fn>;
    let showInformationMessage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        handlers.clear();
        getActiveIssueForActions = vi.fn();
        removeIssueFromList = vi.fn();
        showInformationMessage = vi.mocked(vscode.window.showInformationMessage);

        const deps = {
            reviewEngine: undefined,
            configManager: undefined,
            reviewPanel: {
                getActiveIssueForActions,
                removeIssueFromList,
            },
            statusBar: undefined,
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            getGitRoot: () => null,
        } as any;
        registerIgnoreIssueCommand(deps);
    });

    it('无 issue 时应提示请先选中或悬停', async () => {
        getActiveIssueForActions.mockReturnValue(null);
        const handler = handlers.get('agentreview.ignoreIssue');
        expect(handler).toBeDefined();
        await handler!(undefined);

        expect(showInformationMessage).toHaveBeenCalledWith('请先在审查结果中选中一个问题，或悬停到问题行后再执行忽略');
        expect(removeIssueFromList).not.toHaveBeenCalled();
    });

    it('error 级别时应提示不可忽略且不调用 removeIssueFromList', async () => {
        const errorIssue: ReviewIssue = {
            file: 'd:/ws/src/a.ts',
            line: 1,
            column: 1,
            message: 'e',
            rule: 'r',
            severity: 'error',
        };
        const treeItem = { issue: errorIssue } as ReviewTreeItem;
        getActiveIssueForActions.mockReturnValue(null);

        const handler = handlers.get('agentreview.ignoreIssue');
        await handler!(treeItem);

        expect(showInformationMessage).toHaveBeenCalledWith('error 级别不可忽略');
        expect(removeIssueFromList).not.toHaveBeenCalled();
    });

    it('warning 且有 workspace 时应写指纹并 removeIssueFromList', async () => {
        const warningIssue: ReviewIssue = {
            file: 'd:/ws/src/a.ts',
            line: 2,
            column: 3,
            message: 'w',
            rule: 'no_xxx',
            severity: 'warning',
        };
        const treeItem = { issue: warningIssue } as ReviewTreeItem;
        getActiveIssueForActions.mockReturnValue(null);

        vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
            getText: () => 'const x = 1;\nconst y = 2;',
        } as any);

        const handler = handlers.get('agentreview.ignoreIssue');
        await handler!(treeItem);

        expect(addIgnoredFingerprintMock).toHaveBeenCalled();
        expect(addIgnoredFingerprintMock.mock.calls[0][0]).toBe('d:/ws');
        expect(addIgnoredFingerprintMock.mock.calls[0][2].file).toMatch(/src[\\/]a\.ts/);
        expect(addIgnoredFingerprintMock.mock.calls[0][2].line).toBe(2);
        expect(addIgnoredFingerprintMock.mock.calls[0][2].rule).toBe('no_xxx');
        expect(addIgnoredFingerprintMock.mock.calls[0][2].message).toBe('w');
        expect(addIgnoredFingerprintMock.mock.calls[0][2].severity).toBe('warning');
        expect(removeIssueFromList).toHaveBeenCalledWith(warningIssue);
        expect(showInformationMessage).toHaveBeenCalledWith('已忽略，已从列表移除');
    });

    it('warning 携带 workspaceRoot 时应优先写入该项目忽略仓', async () => {
        const warningIssue: ReviewIssue = {
            file: 'd:/ws-b/src/a.ts',
            line: 2,
            column: 3,
            message: 'w',
            rule: 'no_xxx',
            severity: 'warning',
            workspaceRoot: 'd:/ws-b',
        };
        const treeItem = { issue: warningIssue } as ReviewTreeItem;
        getActiveIssueForActions.mockReturnValue(null);

        vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
            getText: () => 'const x = 1;\nconst y = 2;',
        } as any);

        const handler = handlers.get('agentreview.ignoreIssue');
        await handler!(treeItem);

        expect(addIgnoredFingerprintMock).toHaveBeenCalled();
        expect(addIgnoredFingerprintMock.mock.calls[0][0]).toBe('d:/ws-b');
        expect(addIgnoredFingerprintMock.mock.calls[0][2].file).toBe('src/a.ts');
    });
});
