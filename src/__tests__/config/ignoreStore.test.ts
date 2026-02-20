/**
 * ignoreStore 单元测试（指纹文件 version 2 格式）
 *
 * 覆盖：loadIgnoredFingerprints 无文件/空/有效 items；addIgnoredFingerprint 写入可读 meta、不重复添加。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
    getIgnoreStorePath,
    loadIgnoredFingerprints,
    addIgnoredFingerprint,
    type IgnoreItemMeta,
} from '../../config/ignoreStore';
import { createTempFileSystem, TempFileSystem } from '../helpers/tempFileSystem';

describe('ignoreStore', () => {
    let tempFs: TempFileSystem;

    beforeEach(async () => {
        tempFs = await createTempFileSystem();
    });

    afterEach(async () => {
        if (tempFs) {
            await tempFs.cleanup();
        }
    });

    describe('loadIgnoredFingerprints', () => {
        it('无文件时应返回空数组', async () => {
            const root = tempFs.getTempDir();
            const list = await loadIgnoredFingerprints(root);
            expect(list).toEqual([]);
        });

        it('version 2 且 items 为空时应返回空数组', async () => {
            await tempFs.createFile(
                '.vscode/agentreview-ignore.json',
                JSON.stringify({ version: 2, items: [] }, null, 2)
            );
            const root = tempFs.getTempDir();
            const list = await loadIgnoredFingerprints(root);
            expect(list).toEqual([]);
        });

        it('version 2 且 items 有项时应返回各 fingerprint 数组', async () => {
            const items = [
                { fingerprint: 'fp1', file: 'src/a.ts', line: 10, rule: 'r1', message: 'm1', severity: 'warning' },
                { fingerprint: 'fp2', file: 'src/b.ts', line: 2, rule: 'r2', severity: 'info' },
            ];
            await tempFs.createFile(
                '.vscode/agentreview-ignore.json',
                JSON.stringify({ version: 2, items }, null, 2)
            );
            const root = tempFs.getTempDir();
            const list = await loadIgnoredFingerprints(root);
            expect(list).toEqual(['fp1', 'fp2']);
        });
    });

    describe('addIgnoredFingerprint', () => {
        it('应创建 .vscode 目录并写入 version 2 格式且含 meta', async () => {
            const root = tempFs.getTempDir();
            const meta: IgnoreItemMeta = {
                file: 'src/foo.ts',
                line: 5,
                rule: 'no_xxx',
                message: '简短描述',
                severity: 'warning',
            };
            await addIgnoredFingerprint(root, 'abc16charshex____', meta);

            const storePath = getIgnoreStorePath(root);
            const raw = await fs.promises.readFile(storePath, 'utf8');
            const data = JSON.parse(raw);
            expect(data.version).toBe(2);
            expect(Array.isArray(data.items)).toBe(true);
            expect(data.items.length).toBe(1);
            expect(data.items[0].fingerprint).toBe('abc16charshex____');
            expect(data.items[0].file).toBe('src/foo.ts');
            expect(data.items[0].line).toBe(5);
            expect(data.items[0].rule).toBe('no_xxx');
            expect(data.items[0].message).toBe('简短描述');
            expect(data.items[0].severity).toBe('warning');
            expect(typeof data.items[0].ignoredAt).toBe('string');
        });

        it('同一 fingerprint 重复添加不应重复写入', async () => {
            const root = tempFs.getTempDir();
            const meta: IgnoreItemMeta = { file: 'a.ts', line: 1, rule: 'r' };
            await addIgnoredFingerprint(root, 'samefp', meta);
            await addIgnoredFingerprint(root, 'samefp', meta);

            const storePath = getIgnoreStorePath(root);
            const raw = await fs.promises.readFile(storePath, 'utf8');
            const data = JSON.parse(raw);
            expect(data.items.length).toBe(1);
        });
    });
});
