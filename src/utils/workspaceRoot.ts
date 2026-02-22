/**
 * 有效工作区根解析
 *
 * 统一入口：单根时等价于 workspaceFolders[0]，无 folder 时返回 undefined。
 * 供配置、扫描、审查、忽略、日志等模块使用，为多根兼容预留扩展点。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export const getWorkspaceFolders = (): vscode.WorkspaceFolder[] => {
    const folders = vscode.workspace.workspaceFolders;
    return folders ? [...folders] : [];
};

export const getWorkspaceFolderByFile = (filePath: string): vscode.WorkspaceFolder | undefined => {
    if (!filePath) return undefined;
    const folders = getWorkspaceFolders();
    const normalizedTarget = filePath.replace(/\\/g, '/').toLowerCase();
    return folders.find(folder => {
        const root = folder.uri.fsPath.replace(/\\/g, '/').toLowerCase();
        return normalizedTarget === root || normalizedTarget.startsWith(`${root}/`);
    });
};

export const getGitWorkspaceFolders = (
    existsSync: (targetPath: string) => boolean = fs.existsSync
): vscode.WorkspaceFolder[] =>
    getWorkspaceFolders().filter(folder => existsSync(path.join(folder.uri.fsPath, '.git')));

/**
 * 返回当前有效工作区根。无 folder 返回 undefined；否则返回第一个 folder（单根行为与 [0] 一致）。
 */
export const getEffectiveWorkspaceRoot = (): vscode.WorkspaceFolder | undefined => {
    const folders = getWorkspaceFolders();
    if (!folders || folders.length === 0) return undefined;
    return folders[0];
};
