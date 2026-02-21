/**
 * 日志模块：所有 Logger 实例共享同一 VSCode 输出通道（单例），供插件各模块打点与排查问题。
 */
import * as vscode from 'vscode';

let sharedOutputChannel: vscode.OutputChannel | undefined;

export class Logger {
    /** 插件停用时统一清理共享输出通道，由 extension.deactivate 调用 */
    static disposeSharedOutputChannel = (): void => {
        if (sharedOutputChannel) {
            sharedOutputChannel.dispose();
            sharedOutputChannel = undefined;
        }
    };
    private outputChannel: vscode.OutputChannel;
    private prefix: string;
    private static infoOutputEnabled = true;

    static setInfoOutputEnabled = (enabled: boolean): void => {
        Logger.infoOutputEnabled = enabled;
    };

    constructor(prefix: string = 'AgentReview') {
        this.prefix = prefix;
        if (!sharedOutputChannel) {
            sharedOutputChannel = vscode.window.createOutputChannel('AgentReview');
        }
        this.outputChannel = sharedOutputChannel;
    }

    private appendArgs(args: unknown[]): void {
        if (args.length > 0) this.outputChannel.appendLine(JSON.stringify(args, null, 2));
    }

    info(message: string, ...args: unknown[]): void {
        const logMessage = `[${this.prefix}] [INFO] ${message}`;
        if (Logger.infoOutputEnabled) {
            this.outputChannel.appendLine(logMessage);
            this.appendArgs(args);
        }
    }

    important(message: string, ...args: unknown[]): void {
        this.outputChannel.appendLine(`[${this.prefix}] [IMPORTANT] ${message}`);
        this.appendArgs(args);
    }

    debug(message: string, ...args: unknown[]): void {
        this.outputChannel.appendLine(`[${this.prefix}] [DEBUG] ${message}`);
        this.appendArgs(args);
    }

    error(message: string, error?: unknown): void {
        this.outputChannel.appendLine(`[${this.prefix}] [ERROR] ${message}`);
        if (error != null) {
            this.outputChannel.appendLine(
                error instanceof Error ? (error.stack ?? error.message) : String(error)
            );
        }
    }

    warn(message: string, ...args: unknown[]): void {
        this.outputChannel.appendLine(`[${this.prefix}] [WARN] ${message}`);
        this.appendArgs(args);
    }

    show(): void {
        this.outputChannel.show();
    }

    dispose(): void {
        // 不 dispose 共享通道，由 disposeSharedOutputChannel 在插件停用时统一清理
    }
}
