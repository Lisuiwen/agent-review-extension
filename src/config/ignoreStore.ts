/**
 * 项目级忽略指纹存储（仅用于「忽略」操作，放行不写此处）
 *
 * 一律使用 version 2 格式：items 数组，每项含 fingerprint + 可读 meta（file、line、rule、message、severity 等），
 * 便于人工识别 .vscode/agentreview-ignore.json 中忽略了什么问题。
 * 审查过滤时 loadIgnoredFingerprints 返回 fingerprint 字符串数组供引擎使用。
 */

import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/logger';

const FILENAME = 'agentreview-ignore.json';
const STORE_VERSION = 2;
const logger = new Logger('ignoreStore');

/** 单条忽略条目的可读元数据，便于人在 JSON 中识别 */
export type IgnoreItemMeta = {
    file: string;   // 相对路径
    line: number;
    rule: string;
    message?: string;
    severity?: string;
};

/** 单条存储结构 */
export type IgnoreStoreItem = {
    fingerprint: string;
    file: string;
    line: number;
    rule: string;
    message?: string;
    severity?: string;
    ignoredAt?: string; // ISO 时间字符串，可选
};

/** 存储文件完整结构 */
type IgnoreStoreData = {
    version: number;
    items: IgnoreStoreItem[];
};

/** 存储文件路径：<workspaceRoot>/.vscode/agentreview-ignore.json */
export const getIgnoreStorePath = (workspaceRoot: string): string =>
    path.join(workspaceRoot, '.vscode', FILENAME);

/** 读取并解析存储文件；无文件或解析失败返回 { version: 2, items: [] } */
const loadRaw = async (storePath: string): Promise<IgnoreStoreData> => {
    try {
        const content = await fs.promises.readFile(storePath, 'utf8');
        const data = JSON.parse(content) as { version?: number; items?: IgnoreStoreItem[] };
        if (!Array.isArray(data.items)) {
            return { version: STORE_VERSION, items: [] };
        }
        return {
            version: typeof data.version === 'number' ? data.version : STORE_VERSION,
            items: data.items,
        };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn('读取忽略指纹文件失败', err);
        }
        return { version: STORE_VERSION, items: [] };
    }
};

/**
 * 加载已忽略的指纹列表；供审查引擎过滤用。从 items 中取 fingerprint 组成数组。
 */
export const loadIgnoredFingerprints = async (workspaceRoot: string): Promise<string[]> => {
    const storePath = getIgnoreStorePath(workspaceRoot);
    const data = await loadRaw(storePath);
    return data.items.map(item => item.fingerprint);
};

/**
 * 将指纹加入项目级忽略列表并写回；若已存在则不重复添加。会确保 .vscode 目录存在。
 * meta 必传，用于文件内可读（file 为相对路径、line、rule、message、severity）。
 */
export const addIgnoredFingerprint = async (
    workspaceRoot: string,
    fingerprint: string,
    meta: IgnoreItemMeta
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
    const exists = data.items.some(item => item.fingerprint === fingerprint);
    if (exists) {
        return;
    }
    const newItem: IgnoreStoreItem = {
        fingerprint,
        file: meta.file,
        line: meta.line,
        rule: meta.rule,
        message: meta.message,
        severity: meta.severity,
        ignoredAt: new Date().toISOString(),
    };
    data.items.push(newItem);
    const toWrite: IgnoreStoreData = { version: STORE_VERSION, items: data.items };
    try {
        await fs.promises.writeFile(
            storePath,
            JSON.stringify(toWrite, null, 2),
            'utf8'
        );
    } catch (err) {
        logger.warn('写入忽略指纹文件失败', err);
    }
};
