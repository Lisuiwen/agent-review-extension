import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ReviewResult } from '../core/reviewEngine';

export class StatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private logger: Logger;

    constructor() {
        this.logger = new Logger('StatusBar');
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'agentreview.showReport';
        this.updateStatus('ready');
    }

    updateStatus(status: 'ready' | 'reviewing' | 'error' | 'warning', result?: ReviewResult): void {
        switch (status) {
            case 'ready':
                this.statusBarItem.text = '$(check) AgentReview';
                this.statusBarItem.tooltip = 'AgentReview 就绪';
                break;
            case 'reviewing':
                this.statusBarItem.text = '$(sync~spin) AgentReview';
                this.statusBarItem.tooltip = '正在审查...';
                break;
            case 'error':
                this.statusBarItem.text = '$(error) AgentReview';
                this.statusBarItem.tooltip = '审查失败';
                break;
            case 'warning':
                if (result) {
                    const errorCount = result.errors.length;
                    const warningCount = result.warnings.length;
                    const infoCount = result.info.length;
                    
                    if (errorCount > 0) {
                        this.statusBarItem.text = `$(error) AgentReview: ${errorCount}个错误`;
                        this.statusBarItem.tooltip = `审查发现问题: ${errorCount}个错误, ${warningCount}个警告, ${infoCount}个信息`;
                    } else if (warningCount > 0) {
                        this.statusBarItem.text = `$(warning) AgentReview: ${warningCount}个警告`;
                        this.statusBarItem.tooltip = `审查发现警告: ${warningCount}个警告, ${infoCount}个信息`;
                    } else {
                        this.statusBarItem.text = '$(check) AgentReview: 通过';
                        this.statusBarItem.tooltip = '审查通过';
                    }
                } else {
                    this.statusBarItem.text = '$(warning) AgentReview';
                    this.statusBarItem.tooltip = '审查有警告';
                }
                break;
        }
        this.statusBarItem.show();
    }

    updateWithResult(result: ReviewResult): void {
        if (result.passed) {
            // 审查通过
            if (result.errors.length > 0) {
                // 有错误但审查通过（可能是warning级别）
                this.updateStatus('warning', result);
            } else if (result.warnings.length > 0 || result.info.length > 0) {
                // 有警告或信息
                this.updateStatus('warning', result);
            } else {
                // 完全通过，无任何问题
                this.updateStatus('ready');
            }
        } else {
            // 审查未通过
            this.updateStatus('warning', result);
        }
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
