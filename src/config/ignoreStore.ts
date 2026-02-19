/**
 * 项目级忽略指纹存储
 *
 * 将用户放行的问题指纹持久化到 .vscode/agentreview-ignore.json，
 * 与 @ai-ignore 注释并存；过滤时先按指纹再按行号。
 */

import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/logger';

const FILENAME = 'agentreview-ignore.json';
const STORE_VERSION = 1;
const logger = new Logger('ignoreStore');

/** 存储文件路径：<workspaceRoot>/.vscode/agentreview-ignore.json */
export const getIgnoreStorePath = (workspaceRoot: string): string =>
    path.join(workspaceRoot, '.vscode', FILENAME);

/** 存储格式 */
const loadRaw = async (storePath: string): Promise<{ version: number; fingerprints: string[] } | null> => {
    try {
        const content = await fs.promises.readFile(storePath, 'utf8');
        const data = JSON.parse(content) as { version?: number; fingerprints?: string[] };
        if (!Array.isArray(data.fingerprints)) {
            return null;
        }
        return {
            version: typeof data.version === 'number' ? data.version : STORE_VERSION,
            fingerprints: data.fingerprints,
        };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn('读取忽略指纹文件失败', err);
        }
        return null;
    }
};

/**
 * 加载已忽略的指纹列表；无文件或解析失败返回 []
 */
export const loadIgnoredFingerprints = async (workspaceRoot: string): Promise<string[]> => {
    const storePath = getIgnoreStorePath(workspaceRoot);
    const data = await loadRaw(storePath);
    return data?.fingerprints ?? [];
};

/**
 * 将指纹加入项目级忽略列表并写回；若已存在则不重复添加。会确保 .vscode 目录存在。
 */
export const addIgnoredFingerprint = async (
    workspaceRoot: string,
    fingerprint: string
): Promise<void> => {
    if (!fingerprint) {
        return;
    }
    const vscodeDir = path.join(workspaceRoot, '.vscode');
    const storePath = getIgnoreStorePath(workspaceRoot);
    try {
        await fs.promises.mkdir(vscodeDir, { recursive: true });
    } catch (err) {
        logger.warn('创建 .vscode 目录失败', err);
        return;
    }
    const data = await loadRaw(storePath);
    const fingerprints = data?.fingerprints ?? [];
    if (fingerprints.includes(fingerprint)) {
        return;
    }
    fingerprints.push(fingerprint);
    const toWrite = { version: STORE_VERSION, fingerprints };
    try {
        await fs.promises.writeFile(
            storePath,
            JSON.stringify(toWrite, null, 2),
            'utf8'
        );
    } catch (err) {
        logger.warn('写入忽略指纹文件失败', err);
    }
}
