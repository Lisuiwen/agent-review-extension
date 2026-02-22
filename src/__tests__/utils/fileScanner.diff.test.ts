/**
 * FileScanner diff 闄嶅櫔娴嬭瘯
 *
 * 鐩爣锛?
 * 1. 楠岃瘉 working diff 涔熶細浜у嚭 formatOnly 鏍囪
 * 2. 楠岃瘉鈥滆涔?diff 涓虹┖鈥濅笌鈥滆涔?diff 闈炵┖鈥濅袱绉嶅垎鏀?
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

const { execAsyncMock } = vi.hoisted(() => ({
    execAsyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
    exec: Object.assign(
        (_command: string, _options: unknown, _callback: unknown) => {},
        {
            [Symbol.for('nodejs.util.promisify.custom')]: (command: string, options: unknown) =>
                execAsyncMock(command, options),
        }
    ),
}));

import { FileScanner } from '../../utils/fileScanner';

const createRawDiff = (relativePath: string): string => [
    `diff --git a/${relativePath} b/${relativePath}`,
    'index 1111111..2222222 100644',
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    '@@ -1,1 +1,1 @@',
    '-<template>',
    '+<template>',
    '',
].join('\n');

describe('FileScanner working diff formatOnly', () => {
    const workspaceRoot = path.normalize('D:/workspace/repo');
    const relativePath = 'src/sample.vue';
    const absolutePath = path.normalize(path.join(workspaceRoot, relativePath));

    beforeEach(() => {
        execAsyncMock.mockReset();
        (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
            {
                uri: { fsPath: workspaceRoot },
                name: 'repo',
                index: 0,
            },
        ];
    });

    it('璇箟 diff 涓虹┖鏃跺簲鍒ゅ畾涓?formatOnly=true', async () => {
        execAsyncMock.mockImplementation(async (command: string) => {
            if (command.includes('--ignore-blank-lines')) {
                return { stdout: '', stderr: '' };
            }
            return { stdout: createRawDiff(relativePath), stderr: '' };
        });

        const scanner = new FileScanner();
        const result = await scanner.getWorkingDiff(workspaceRoot, [absolutePath]);
        const fileDiff = result.get(absolutePath);
        expect(fileDiff).toBeDefined();
        expect(fileDiff?.formatOnly).toBe(true);
        expect(fileDiff?.commentOnly).toBe(false);
        expect(fileDiff?.addedLines).toBe(1);
        expect(fileDiff?.deletedLines).toBe(1);
        expect(fileDiff?.addedContentLines).toEqual(['<template>']);
    });

    it('璇箟 diff 浠嶆湁鍐呭鏃跺簲鍒ゅ畾涓?formatOnly=false', async () => {
        execAsyncMock.mockResolvedValue({ stdout: createRawDiff(relativePath), stderr: '' });

        const scanner = new FileScanner();
        const result = await scanner.getWorkingDiff(workspaceRoot, [absolutePath]);
        const fileDiff = result.get(absolutePath);
        expect(fileDiff).toBeDefined();
        expect(fileDiff?.formatOnly).toBe(false);
        expect(fileDiff?.commentOnly).toBe(false);
        expect(fileDiff?.addedLines).toBe(1);
        expect(fileDiff?.deletedLines).toBe(1);
        expect(fileDiff?.addedContentLines).toEqual(['<template>']);
    });

    it('浠呮敞閲婂樊寮傛椂搴斿垽瀹氫负 commentOnly=true 涓?formatOnly=false', async () => {
        execAsyncMock.mockImplementation(async (command: string) => {
            if (command.includes(' -I "')) {
                return { stdout: '', stderr: '' };
            }
            return { stdout: createRawDiff(relativePath), stderr: '' };
        });

        const scanner = new FileScanner();
        const result = await scanner.getWorkingDiff(workspaceRoot, [absolutePath]);
        const fileDiff = result.get(absolutePath);
        expect(fileDiff).toBeDefined();
        expect(fileDiff?.formatOnly).toBe(false);
        expect(fileDiff?.commentOnly).toBe(true);
    });

    it('格式与注释混合噪声变更应至少命中一种噪声标记', async () => {
        execAsyncMock.mockImplementation(async (command: string) => {
            if (command.includes('--ignore-blank-lines')) {
                return { stdout: '', stderr: '' };
            }
            return { stdout: createRawDiff(relativePath), stderr: '' };
        });

        const scanner = new FileScanner();
        const result = await scanner.getWorkingDiff(workspaceRoot, [absolutePath]);
        const fileDiff = result.get(absolutePath);
        expect(fileDiff).toBeDefined();
        expect(fileDiff?.formatOnly === true || fileDiff?.commentOnly === true).toBe(true);
    });

    it('working diff 涓虹┖浣嗘枃浠朵负 untracked 鏃讹紝搴旇ˉ鍏呰鏂囦欢鐨?diff hunk', async () => {
        const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockResolvedValue('const x = 1;');
        execAsyncMock.mockImplementation(async (command: string) => {
            if (command.includes('ls-files --others --exclude-standard')) {
                return { stdout: `${relativePath}\n`, stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });

        const scanner = new FileScanner();
        const result = await scanner.getWorkingDiff(workspaceRoot, [absolutePath]);
        const fileDiff = result.get(absolutePath);

        expect(fileDiff).toBeDefined();
        expect(fileDiff?.formatOnly).toBe(false);
        expect(fileDiff?.commentOnly).toBe(false);
        expect(fileDiff?.hunks.length).toBe(1);
        expect(fileDiff?.hunks[0].newStart).toBe(1);
        expect(fileDiff?.hunks[0].newCount).toBeGreaterThan(0);
        expect(fileDiff?.addedLines).toBe(fileDiff?.hunks[0].newCount);
        expect(fileDiff?.deletedLines).toBe(0);
        expect(fileDiff?.addedContentLines?.length).toBe(fileDiff?.hunks[0].newCount);

        readFileSpy.mockRestore();
    });
});

describe('FileScanner pending diff', () => {
    const workspaceRoot = path.normalize('D:/workspace/repo');
    const relativePath = 'src/sample.vue';
    const absolutePath = path.normalize(path.join(workspaceRoot, relativePath));
    const untrackedRelativePath = 'src/new-file.ts';
    const untrackedAbsolutePath = path.normalize(path.join(workspaceRoot, untrackedRelativePath));

    beforeEach(() => {
        execAsyncMock.mockReset();
        (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
            {
                uri: { fsPath: workspaceRoot },
                name: 'repo',
                index: 0,
            },
        ];
    });

    it('pending diff 搴旂粺涓€瑕嗙洊 tracked 涓?untracked 鏂囦欢', async () => {
        const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockResolvedValue('const n = 1;');
        execAsyncMock.mockImplementation(async (command: string) => {
            if (command.startsWith('git rev-parse --verify HEAD')) {
                return { stdout: 'abc123\n', stderr: '' };
            }
            if (command.includes('ls-files --others --exclude-standard')) {
                return { stdout: `${untrackedRelativePath}\n`, stderr: '' };
            }
            if (command.includes('git diff HEAD')) {
                return { stdout: createRawDiff(relativePath), stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });

        const scanner = new FileScanner();
        const result = await scanner.getPendingDiff(workspaceRoot);

        expect(result.has(absolutePath)).toBe(true);
        expect(result.has(untrackedAbsolutePath)).toBe(true);
        expect(execAsyncMock).toHaveBeenCalledWith(
            expect.stringContaining('git diff HEAD -U3 --no-color'),
            expect.anything()
        );
        readFileSpy.mockRestore();
    });

    it('鏃?HEAD 鏃跺簲鍥為€€绌烘爲鍩哄噯缁х画鑾峰彇 pending diff', async () => {
        execAsyncMock.mockImplementation(async (command: string) => {
            if (command.startsWith('git rev-parse --verify HEAD')) {
                const error = new Error('bad revision HEAD') as Error & { code?: number };
                error.code = 128;
                throw error;
            }
            if (command.includes('4b825dc642cb6eb9a060e54bf8d69288fbee4904')) {
                return { stdout: createRawDiff(relativePath), stderr: '' };
            }
            if (command.includes('ls-files --others --exclude-standard')) {
                return { stdout: '', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });

        const scanner = new FileScanner();
        const result = await scanner.getPendingDiff(workspaceRoot, [absolutePath]);

        expect(result.has(absolutePath)).toBe(true);
        expect(execAsyncMock).toHaveBeenCalledWith(
            expect.stringContaining('git diff 4b825dc642cb6eb9a060e54bf8d69288fbee4904 -U3 --no-color'),
            expect.anything()
        );
    });
});

