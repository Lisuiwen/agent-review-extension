/**
 * 有效工作区根解析
 *
 * 统一入口：单根时等价于 workspaceFolders[0]，无 folder 时返回 undefined。
 * 供配置、扫描、审查、忽略、日志等模块使用，为多根兼容预留扩展点。
 */

import * as vscode from 'vscode';

/**
 * 返回当前有效工作区根。无 folder 返回 undefined；否则返回第一个 folder（单根行为与 [0] 一致）。
 */
export const getEffectiveWorkspaceRoot = (): vscode.WorkspaceFolder | undefined => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return folders[0];
};
