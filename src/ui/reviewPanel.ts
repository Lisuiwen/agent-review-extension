import * as vscode from 'vscode';
import { ReviewResult, ReviewIssue } from '../core/reviewEngine';

export class ReviewPanel {
    private panel: vscode.WebviewPanel | undefined;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    showReviewResult(result: ReviewResult): void {
        // TODO: 创建或显示审查结果面板
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'agentReview',
                'AgentReview 审查报告',
                vscode.ViewColumn.Two,
                {}
            );
        }

        // TODO: 设置webview内容
        this.panel.webview.html = this.getWebviewContent(result);
        this.panel.reveal();
    }

    private getWebviewContent(result: ReviewResult): string {
        // TODO: 生成HTML内容显示审查结果
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>AgentReview 审查报告</title>
            </head>
            <body>
                <h1>审查结果</h1>
                <p>状态: ${result.passed ? '通过' : '失败'}</p>
                <!-- TODO: 显示详细结果 -->
            </body>
            </html>
        `;
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
    }
}
