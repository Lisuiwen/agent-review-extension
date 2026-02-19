/**
 * 命令：agentreview.allowIssueIgnore - 放行当前问题（写入 @ai-ignore 注释）
 *
 * 行为：
 * 1. 从 reviewPanel 当前激活的问题读取 file/line
 * 2. 在目标行上方插入注释（保留原缩进）
 * 3. 后续审查由 ReviewEngine.filterIgnoredIssues 按标记过滤该问题
 */

import * as vscode from 'vscode';
import type { CommandContext } from './commandContext';

const commentPrefixByLanguage: Record<string, string> = {
    javascript: '//',
    typescript: '//',
    javascriptreact: '//',
    typescriptreact: '//',
    java: '//',
    c: '//',
    cpp: '//',
    csharp: '//',
    go: '//',
    rust: '//',
    php: '//',
    swift: '//',
    kotlin: '//',
    scala: '//',
    css: '/*',
    scss: '//',
    less: '//',
    python: '#',
    shellscript: '#',
    yaml: '#',
    plaintext: '//',
    sql: '--',
    xml: '<!--',
    html: '<!--',
    vue: '<!--',
};

const buildIgnoreComment = (languageId: string, indent: string, reason: string): string => {
    const prefix = commentPrefixByLanguage[languageId] ?? '//';
    if (prefix === '/*') {
        return `${indent}/* @ai-ignore: ${reason} */\n`;
    }
    if (prefix === '<!--') {
        return `${indent}<!-- @ai-ignore: ${reason} -->\n`;
    }
    return `${indent}${prefix} @ai-ignore: ${reason}\n`;
};

export const registerAllowIssueIgnoreCommand = (deps: CommandContext): vscode.Disposable =>
    vscode.commands.registerCommand('agentreview.allowIssueIgnore', async () => {
        const { reviewPanel } = deps;
        const issue = reviewPanel?.getActiveIssueForActions();
        if (!issue) {
            vscode.window.showInformationMessage('请先在审查结果中选中一个问题，或悬停到问题行后再执行放行');
            return;
        }

        const reason = await vscode.window.showInputBox({
            prompt: '请输入放行原因（会写入 @ai-ignore 注释）',
            placeHolder: '例如：历史遗留、当前迭代暂不处理',
            value: '当前迭代暂不处理',
            validateInput: (value) => value.trim().length === 0 ? '原因不能为空' : undefined,
        });
        if (!reason) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(issue.file));
        const lineIndex = Math.max(0, Math.min(issue.line - 1, document.lineCount - 1));
        const targetLineText = document.lineAt(lineIndex).text;
        const indentMatch = targetLineText.match(/^\s*/);
        const indent = indentMatch ? indentMatch[0] : '';
        const insertText = buildIgnoreComment(document.languageId, indent, reason.trim());

        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(lineIndex, 0), insertText);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showErrorMessage('放行失败：无法写入 @ai-ignore 注释');
            return;
        }
        await document.save();
        await reviewPanel?.syncAfterIssueIgnore({
            filePath: issue.file,
            insertedLine: lineIndex + 1,
        });
        vscode.window.showInformationMessage('已插入 @ai-ignore 注释，此问题后续审查将被忽略');
    });
