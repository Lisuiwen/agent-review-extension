/**
 * 独立文件扫描（无 VSCode 依赖）
 *
 * 给定 workspaceRoot 执行 git diff --cached --name-only，供 hookRunner 使用。
 */

import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * 获取 staged 文件列表（绝对路径）
 */
export const getStagedFiles = async (workspaceRoot: string): Promise<string[]> => {
    try {
        const { stdout } = await execAsync('git diff --cached --name-only', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
        return stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(file => path.isAbsolute(file) ? file : path.join(workspaceRoot, file));
    } catch (error: any) {
        if (error.code === 1) {
            return [];
        }
        throw error;
    }
};
