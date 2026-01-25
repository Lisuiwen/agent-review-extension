import * as vscode from 'vscode';

// 单例：所有 Logger 实例共享同一个输出通道
// VSCode 的 createOutputChannel 会根据名称返回同一个通道实例
let sharedOutputChannel: vscode.OutputChannel | undefined;

export class Logger {
    private outputChannel: vscode.OutputChannel;
    private prefix: string;

    constructor(prefix: string = 'AgentReview') {
        this.prefix = prefix;
        // 使用单例模式，确保所有 Logger 实例共享同一个输出通道
        if (!sharedOutputChannel) {
            sharedOutputChannel = vscode.window.createOutputChannel('AgentReview');
        }
        this.outputChannel = sharedOutputChannel;
    }

    info(message: string, ...args: any[]): void {
        const logMessage = `[${this.prefix}] [INFO] ${message}`;
        this.outputChannel.appendLine(logMessage);
        if (args.length > 0) {
            this.outputChannel.appendLine(JSON.stringify(args, null, 2));
        }
    }

    debug(message: string, ...args: any[]): void {
        const logMessage = `[${this.prefix}] [DEBUG] ${message}`;
        this.outputChannel.appendLine(logMessage);
        if (args.length > 0) {
            this.outputChannel.appendLine(JSON.stringify(args, null, 2));
        }
    }

    error(message: string, error?: any): void {
        const logMessage = `[${this.prefix}] [ERROR] ${message}`;
        this.outputChannel.appendLine(logMessage);
        if (error) {
            this.outputChannel.appendLine(error instanceof Error ? error.stack || error.message : String(error));
        }
    }

    warn(message: string, ...args: any[]): void {
        const logMessage = `[${this.prefix}] [WARN] ${message}`;
        this.outputChannel.appendLine(logMessage);
        if (args.length > 0) {
            this.outputChannel.appendLine(JSON.stringify(args, null, 2));
        }
    }

    show(): void {
        this.outputChannel.show();
    }

    dispose(): void {
        // 注意：不要在这里 dispose 共享的输出通道
        // 因为其他 Logger 实例可能还在使用它
        // 输出通道应该在插件停用时统一清理
        // this.outputChannel.dispose();
    }
}
