import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentReviewConfig } from '../types/config';

/**
 * 解析运行链路日志基础目录。
 *
 * 默认策略：
 * - workspace_docs_logs: <workspaceRoot>/docs/logs
 * 回退策略：
 * - global_storage: context.globalStorageUri.fsPath
 * - 最终回退: <extensionPath>/.agentreview-runtime
 */
export const resolveRuntimeLogBaseDir = (
    context: vscode.ExtensionContext,
    runtimeLogConfig?: AgentReviewConfig['runtime_log']
): string => {
    const mode = runtimeLogConfig?.base_dir_mode ?? 'workspace_docs_logs';

    if (mode === 'workspace_docs_logs') {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            return path.join(workspaceRoot, 'docs', 'logs');
        }
    }

    return context.globalStorageUri?.fsPath || path.join(context.extensionPath, '.agentreview-runtime');
};

