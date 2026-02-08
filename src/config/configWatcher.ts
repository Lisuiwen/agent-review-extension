/**
 * 配置与 .env 文件监听（防抖触发 onReload）
 *
 * 供 ConfigManager 在 initialize 中调用，返回 disposable。
 */

import * as vscode from 'vscode';

const DEFAULT_DEBOUNCE_MS = 300;

export interface ConfigWatcherDisposable {
    dispose(): void;
}

/**
 * 创建对 .agentreview.yaml 与 .env 的监听，防抖后触发 onReload
 */
export const setupConfigWatcher = (
    workspaceFolder: vscode.WorkspaceFolder,
    configPath: string,
    envPath: string,
    onReload: () => void | Promise<void>,
    debounceMs: number = DEFAULT_DEBOUNCE_MS
): ConfigWatcherDisposable => {
    const configWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder, '.agentreview.yaml')
    );
    const envWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder, '.env')
    );

    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReload = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
            reloadTimer = undefined;
            void Promise.resolve(onReload()).catch(() => {});
        }, debounceMs);
    };

    configWatcher.onDidChange(scheduleReload);
    configWatcher.onDidCreate(scheduleReload);
    configWatcher.onDidDelete(scheduleReload);
    envWatcher.onDidChange(scheduleReload);
    envWatcher.onDidCreate(scheduleReload);
    envWatcher.onDidDelete(scheduleReload);

    return {
        dispose: () => {
            if (reloadTimer) clearTimeout(reloadTimer);
            configWatcher.dispose();
            envWatcher.dispose();
        },
    };
};
