import * as vscode from 'vscode';

export class Logger {
    private outputChannel: vscode.OutputChannel;
    private prefix: string;

    constructor(prefix: string = 'AgentReview') {
        this.prefix = prefix;
        this.outputChannel = vscode.window.createOutputChannel('AgentReview');
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
        this.outputChannel.dispose();
    }
}
