import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEffectiveWorkspaceRoot, getGitWorkspaceFolders, getWorkspaceFolderByFile, getWorkspaceFolders } from '../../utils/workspaceRoot';

describe('getEffectiveWorkspaceRoot', () => {
    const originalWorkspaceFolders = (vscode.workspace as any).workspaceFolders;

    afterEach(() => {
        (vscode.workspace as any).workspaceFolders = originalWorkspaceFolders;
    });

    it('无 folder 时返回 undefined', () => {
        (vscode.workspace as any).workspaceFolders = [];
        expect(getEffectiveWorkspaceRoot()).toBeUndefined();
    });

    it('workspaceFolders 为 undefined 时返回 undefined', () => {
        (vscode.workspace as any).workspaceFolders = undefined;
        expect(getEffectiveWorkspaceRoot()).toBeUndefined();
    });

    it('单根时返回该 folder', () => {
        const folder = { uri: { fsPath: 'd:/ws' }, name: 'ws' };
        (vscode.workspace as any).workspaceFolders = [folder];
        expect(getEffectiveWorkspaceRoot()).toBe(folder);
    });

    it('多根时返回第一个 folder', () => {
        const first = { uri: { fsPath: 'd:/a' }, name: 'a' };
        const second = { uri: { fsPath: 'd:/b' }, name: 'b' };
        (vscode.workspace as any).workspaceFolders = [first, second];
        expect(getEffectiveWorkspaceRoot()).toBe(first);
    });
});

describe('workspaceRoot helpers', () => {
    const originalWorkspaceFolders = (vscode.workspace as any).workspaceFolders;

    afterEach(() => {
        (vscode.workspace as any).workspaceFolders = originalWorkspaceFolders;
    });

    it('getWorkspaceFolders 在无 folder 时返回空数组', () => {
        (vscode.workspace as any).workspaceFolders = undefined;
        expect(getWorkspaceFolders()).toEqual([]);
    });

    it('getWorkspaceFolderByFile 可按路径定位所属 folder', () => {
        const first = { uri: { fsPath: 'd:/a' }, name: 'a' };
        const second = { uri: { fsPath: 'd:/b' }, name: 'b' };
        (vscode.workspace as any).workspaceFolders = [first, second];
        expect(getWorkspaceFolderByFile('d:/b/src/main.ts')).toBe(second);
    });

    it('getWorkspaceFolderByFile 找不到归属时返回 undefined', () => {
        const first = { uri: { fsPath: 'd:/a' }, name: 'a' };
        (vscode.workspace as any).workspaceFolders = [first];
        expect(getWorkspaceFolderByFile('d:/c/src/main.ts')).toBeUndefined();
    });

    it('getGitWorkspaceFolders 仅返回包含 .git 的项目', () => {
        const first = { uri: { fsPath: 'd:/a' }, name: 'a' };
        const second = { uri: { fsPath: 'd:/b' }, name: 'b' };
        (vscode.workspace as any).workspaceFolders = [first, second];
        const existsSync = vi.fn((p: string) => /[\\/]b[\\/]\.git$/.test(p));
        expect(getGitWorkspaceFolders(existsSync)).toEqual([second]);
    });
});
