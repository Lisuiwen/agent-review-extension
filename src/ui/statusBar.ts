import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

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

    updateStatus(status: 'ready' | 'reviewing' | 'error' | 'warning'): void {
        // TODO: 更新状态栏显示
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
                this.statusBarItem.text = '$(warning) AgentReview';
                this.statusBarItem.tooltip = '审查有警告';
                break;
        }
        this.statusBarItem.show();
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
