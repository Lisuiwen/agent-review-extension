import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRuntimeLogBaseDir } from '../../utils/runtimeLogPath';

const mockContext = (params: { globalStorage?: string; extensionPath?: string }): vscode.ExtensionContext =>
    ({
        globalStorageUri: params.globalStorage
            ? { fsPath: params.globalStorage }
            : undefined,
        extensionPath: params.extensionPath ?? 'D:/ext/agentreview',
    } as unknown as vscode.ExtensionContext);

describe('resolveRuntimeLogBaseDir', () => {
    afterEach(() => {
        (vscode.workspace as any).workspaceFolders = [];
    });

    it('baseDirMode=workspace_docs_logs 且有工作区时，返回 <workspace>/docs/logs', () => {
        (vscode.workspace as any).workspaceFolders = [
            {
                uri: {
                    fsPath: 'D:/Workspace/Projects/VSCODExtension/AgentReview',
                },
            },
        ];

        const baseDir = resolveRuntimeLogBaseDir(
            mockContext({ globalStorage: 'D:/VSCode/globalStorage' }),
            { base_dir_mode: 'workspace_docs_logs' }
        );

        expect(baseDir).toBe(path.join('D:/Workspace/Projects/VSCODExtension/AgentReview', 'docs', 'logs'));
    });

    it('baseDirMode=workspace_docs_logs 且无工作区时，回退 globalStorage', () => {
        (vscode.workspace as any).workspaceFolders = [];
        const baseDir = resolveRuntimeLogBaseDir(
            mockContext({ globalStorage: 'D:/VSCode/globalStorage' }),
            { base_dir_mode: 'workspace_docs_logs' }
        );
        expect(baseDir).toBe('D:/VSCode/globalStorage');
    });

    it('baseDirMode=global_storage 时使用 globalStorage，并在缺失时回退 extensionPath', () => {
        (vscode.workspace as any).workspaceFolders = [
            {
                uri: {
                    fsPath: 'D:/Workspace/Projects/VSCODExtension/AgentReview',
                },
            },
        ];

        const withGlobalStorage = resolveRuntimeLogBaseDir(
            mockContext({ globalStorage: 'D:/VSCode/globalStorage', extensionPath: 'D:/ext/agentreview' }),
            { base_dir_mode: 'global_storage' }
        );
        expect(withGlobalStorage).toBe('D:/VSCode/globalStorage');

        const withoutGlobalStorage = resolveRuntimeLogBaseDir(
            mockContext({ extensionPath: 'D:/ext/agentreview' }),
            { base_dir_mode: 'global_storage' }
        );
        expect(withoutGlobalStorage).toBe(path.join('D:/ext/agentreview', '.agentreview-runtime'));
    });
});

