/**
 * FileScanner diff 降噪测试
 *
 * 目标：
 * 1. 验证 working diff 也会产出 formatOnly 标记
 * 2. 验证“语义 diff 为空”与“语义 diff 非空”两种分支
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
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

    it('语义 diff 为空时应判定为 formatOnly=true', async () => {
        execAsyncMock.mockImplementation(async (command: string) => {
            if (command.includes('--ignore-blank-lines')) {
                return { stdout: '', stderr: '' };
            }
            return { stdout: createRawDiff(relativePath), stderr: '' };
        });

        const scanner = new FileScanner();
        const result = await scanner.getWorkingDiff([absolutePath]);
        const fileDiff = result.get(absolutePath);
        expect(fileDiff).toBeDefined();
        expect(fileDiff?.formatOnly).toBe(true);
    });

    it('语义 diff 仍有内容时应判定为 formatOnly=false', async () => {
        execAsyncMock.mockResolvedValue({ stdout: createRawDiff(relativePath), stderr: '' });

        const scanner = new FileScanner();
        const result = await scanner.getWorkingDiff([absolutePath]);
        const fileDiff = result.get(absolutePath);
        expect(fileDiff).toBeDefined();
        expect(fileDiff?.formatOnly).toBe(false);
    });
});
