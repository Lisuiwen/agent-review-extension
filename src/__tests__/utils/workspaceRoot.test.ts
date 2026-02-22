import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { getEffectiveWorkspaceRoot } from '../../utils/workspaceRoot';

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
