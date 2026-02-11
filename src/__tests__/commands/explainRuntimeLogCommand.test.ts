import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerExplainRuntimeLogCommand } from '../../commands/explainRuntimeLogCommand';

describe('explainRuntimeLogCommand', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(tempDirs.splice(0).map(dir =>
            fs.promises.rm(dir, { recursive: true, force: true })
        ));
    });

    it('应读取最新 jsonl 并生成 summary', async () => {
        const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentreview-cmd-'));
        tempDirs.push(workspaceRoot);
        const runtimeDir = path.join(workspaceRoot, 'docs', 'logs', 'runtime-logs');
        await fs.promises.mkdir(runtimeDir, { recursive: true });
        const jsonlPath = path.join(runtimeDir, '20260210-100000-a1.jsonl');
        await fs.promises.writeFile(
            jsonlPath,
            [
                '{"ts":"2026-02-10T10:00:00.000Z","level":"info","runId":"r1","component":"ReviewEngine","event":"run_start","phase":"review","data":{"trigger":"manual"}}',
                '{"ts":"2026-02-10T10:00:01.000Z","level":"info","runId":"r1","component":"ReviewEngine","event":"run_end","phase":"review","durationMs":1000,"data":{"status":"success"}}',
            ].join('\n'),
            'utf8'
        );

        (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
        const callbackHolder: { cb?: () => Promise<void> } = {};
        vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((_, cb) => {
            callbackHolder.cb = cb as () => Promise<void>;
            return { dispose: () => undefined };
        });
        const showInfoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
        const showDocSpy = vi.spyOn(vscode.window, 'showTextDocument');

        const deps = {
            reviewEngine: undefined,
            configManager: {
                getConfig: () => ({
                    runtime_log: {
                        base_dir_mode: 'workspace_docs_logs',
                        human_readable: {
                            granularity: 'summary_with_key_events',
                        },
                    },
                }),
            },
            gitHookManager: undefined,
            reviewPanel: undefined,
            statusBar: undefined,
            logger: { error: vi.fn() },
            getGitRoot: () => null,
        } as any;

        registerExplainRuntimeLogCommand(deps, {
            extensionPath: workspaceRoot,
            globalStorageUri: { fsPath: path.join(workspaceRoot, '.global') },
        } as any);

        expect(callbackHolder.cb).toBeDefined();
        await callbackHolder.cb!();

        const summaryPath = jsonlPath.replace('.jsonl', '.summary.log');
        expect(await fs.promises.stat(summaryPath)).toBeDefined();
        expect(showDocSpy).toHaveBeenCalled();
        expect(showInfoSpy).toHaveBeenCalled();
    });
});

