import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandContext } from './commandContext';
import { resolveRuntimeLogBaseDir } from '../utils/runtimeLogPath';
import { findLatestRuntimeJsonlFile, generateRuntimeSummaryForFile } from '../utils/runtimeLogExplainer';

export const registerExplainRuntimeLogCommand = (
    deps: CommandContext,
    context: vscode.ExtensionContext
): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.runtimeLog.explainLatest', async () => {
        const { configManager, logger } = deps;
        if (!configManager) {
            vscode.window.showErrorMessage('配置管理器未初始化，无法解释运行日志');
            return;
        }

        try {
            const runtimeLogConfig = configManager.getConfig().runtime_log;
            const baseDir = resolveRuntimeLogBaseDir(context, runtimeLogConfig);
            const runtimeLogDir = path.join(baseDir, 'runtime-logs');
            const latestJsonl = await findLatestRuntimeJsonlFile(runtimeLogDir);
            if (!latestJsonl) {
                vscode.window.showWarningMessage(`未找到运行日志文件: ${runtimeLogDir}`);
                return;
            }

            const granularity = runtimeLogConfig?.human_readable?.granularity ?? 'summary_with_key_events';
            const { summaryPath } = await generateRuntimeSummaryForFile(latestJsonl, { granularity });
            const doc = await vscode.workspace.openTextDocument(summaryPath);
            await vscode.window.showTextDocument(doc, { preview: false });
            vscode.window.showInformationMessage(`运行日志摘要已生成: ${summaryPath}`);
        } catch (error) {
            logger.error('解释运行日志失败', error);
            vscode.window.showErrorMessage('解释运行日志失败，请查看输出日志');
        }
    });

