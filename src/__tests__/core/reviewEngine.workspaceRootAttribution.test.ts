import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { ReviewEngine } from '../../core/reviewEngine';
import { createMockConfigManager } from '../helpers/mockConfigManager';
import { createTempFileSystem, type TempFileSystem } from '../helpers/tempFileSystem';

describe('ReviewEngine workspaceRoot attribution', () => {
    let tempFs: TempFileSystem;

    beforeEach(async () => {
        tempFs = await createTempFileSystem();
        (vscode.workspace as any).workspaceFolders = [{
            uri: { fsPath: tempFs.getTempDir() },
            name: 'ws',
            index: 0,
        }];
    });

    afterEach(async () => {
        await tempFs.cleanup();
        (vscode.workspace as any).workspaceFolders = [];
    });

    it('review 结果中的 issue 应注入 workspaceRoot', async () => {
        const configManager = createMockConfigManager({
            rules: {
                enabled: true,
                strict_mode: false,
                code_quality: {
                    enabled: true,
                    action: 'block_commit',
                    no_todo: false,
                    no_debugger: true,
                },
            },
        });
        const reviewEngine = new ReviewEngine(configManager);
        await reviewEngine.initialize();

        const file = await tempFs.createFile('x.ts', 'function x(){\n  debugger;\n}\n');
        const result = await reviewEngine.review([file]);

        expect(result.errors.length).toBeGreaterThan(0);
        const issue = result.errors.find(item => item.rule === 'no_debugger');
        expect(issue).toBeDefined();
        expect(issue?.workspaceRoot).toBe(tempFs.getTempDir());
    });
});
