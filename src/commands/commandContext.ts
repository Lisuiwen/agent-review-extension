/**
 * 命令依赖上下文
 *
 * 由 extension 在激活时构造并传入各命令注册函数，避免命令内直接依赖全局变量。
 */

import type { ReviewEngine } from '../core/reviewEngine';
import type { ConfigManager } from '../config/configManager';
import type { GitHookManager } from '../hooks/gitHookManager';
import type { ReviewPanel } from '../ui/reviewPanel';
import type { StatusBar } from '../ui/statusBar';
import type { Logger } from '../utils/logger';

/** 获取 Git 根目录的函数（由 extension 提供，依赖 workspace） */
export type GetGitRoot = () => string | null;

export interface CommandContext {
    reviewEngine: ReviewEngine | undefined;
    configManager: ConfigManager | undefined;
    gitHookManager: GitHookManager | undefined;
    reviewPanel: ReviewPanel | undefined;
    statusBar: StatusBar | undefined;
    logger: Logger;
    getGitRoot: GetGitRoot;
}
