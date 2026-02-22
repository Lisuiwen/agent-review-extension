/**
 * 命令依赖上下文
 *
 * 由 extension 在激活时构造并传入各命令注册函数，避免命令内直接依赖全局变量。
 */

import type * as vscode from 'vscode';
import type { ReviewEngine } from '../core/reviewEngine';
import type { ConfigManager } from '../config/configManager';
import type { ReviewPanel } from '../ui/reviewPanel';
import type { StatusBar } from '../ui/statusBar';
import type { Logger } from '../utils/logger';

/** 获取 Git 根目录的函数（由 extension 提供，依赖 workspace） */
export type GetGitRoot = () => string | null;

export interface CommandContext {
    reviewEngine: ReviewEngine | undefined;
    configManager: ConfigManager | undefined;
    reviewPanel: ReviewPanel | undefined;
    statusBar: StatusBar | undefined;
    logger: Logger;
    getGitRoot: GetGitRoot;
    /** 用于持久化 lastReviewedContentHash，重载窗口后回退仍可清除待复审 */
    workspaceState?: vscode.Memento;
    /** run/runStaged 成功应用结果后写入 lastReviewedContentHash（与 manual-review-store-hash 一致） */
    persistLastReviewedHash?: (filePath: string, hash: string) => void;
}
