import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerAllowIssueIgnoreCommand } from '../../commands/allowIssueIgnoreCommand';

const mocked = vi.hoisted(() => ({
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    workspaceEditInserts: [] as Array<{
        uri: { fsPath: string };
        position: { line: number; character: number };
        text: string;
    }>,
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
    openTextDocument: vi.fn(),
    applyEdit: vi.fn(),
}));

vi.mock('vscode', () => ({
    commands: {
        registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
            mocked.handlers.set(id, handler);
            return { dispose: () => mocked.handlers.delete(id) };
        },
    },
    window: {
        showInformationMessage: mocked.showInformationMessage,
        showErrorMessage: mocked.showErrorMessage,
        showInputBox: mocked.showInputBox,
    },
    workspace: {
        openTextDocument: mocked.openTextDocument,
        applyEdit: mocked.applyEdit,
    },
    Uri: {
        file: (path: string) => ({ fsPath: path }),
    },
    Position: class {
        line: number;
        character: number;
        constructor(line: number, character: number) {
            this.line = line;
            this.character = character;
        }
    },
    WorkspaceEdit: class {
        insert(uri: { fsPath: string }, position: { line: number; character: number }, text: string): void {
            mocked.workspaceEditInserts.push({ uri, position, text });
        }
    },
}));

describe('allowIssueIgnoreCommand', () => {
    let getActiveIssueForActions: ReturnType<typeof vi.fn>;
    let syncAfterIssueIgnore: ReturnType<typeof vi.fn>;
    let saveMock: ReturnType<typeof vi.fn>;

    const runCommand = async () => {
        const handler = mocked.handlers.get('agentreview.allowIssueIgnore');
        expect(handler).toBeDefined();
        await handler!();
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocked.handlers.clear();
        mocked.workspaceEditInserts.length = 0;

        getActiveIssueForActions = vi.fn();
        syncAfterIssueIgnore = vi.fn(async () => {});
        saveMock = vi.fn(async () => true);

        registerAllowIssueIgnoreCommand({
            reviewEngine: undefined,
            configManager: undefined,
            statusBar: undefined,
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            getGitRoot: () => null,
            reviewPanel: {
                getActiveIssueForActions,
                syncAfterIssueIgnore,
            },
        } as any);
    });

    it('未选中问题时应提示并返回', async () => {
        getActiveIssueForActions.mockReturnValue(null);

        await runCommand();

        expect(mocked.showInformationMessage).toHaveBeenCalledTimes(1);
        expect(mocked.showInputBox).not.toHaveBeenCalled();
        expect(mocked.openTextDocument).not.toHaveBeenCalled();
    });

    it('输入原因取消时不应写入编辑', async () => {
        getActiveIssueForActions.mockReturnValue({ file: 'd:/ws/a.ts', line: 3 });
        mocked.showInputBox.mockResolvedValue(undefined);

        await runCommand();

        expect(mocked.openTextDocument).not.toHaveBeenCalled();
        expect(mocked.applyEdit).not.toHaveBeenCalled();
        expect(syncAfterIssueIgnore).not.toHaveBeenCalled();
    });

    it('typescript 文件应插入双斜杠注释并走成功链路', async () => {
        getActiveIssueForActions.mockReturnValue({ file: 'd:/ws/a.ts', line: 2 });
        mocked.showInputBox.mockResolvedValue('  历史遗留  ');
        mocked.openTextDocument.mockResolvedValue({
            uri: { fsPath: 'd:/ws/a.ts' },
            languageId: 'typescript',
            lineCount: 3,
            lineAt: (index: number) => ({ text: index === 1 ? '    const x = 1;' : '' }),
            getText: () => 'line1\n    const x = 1;\nline3',
            save: saveMock,
        });
        mocked.applyEdit.mockResolvedValue(true);

        await runCommand();

        expect(mocked.workspaceEditInserts).toHaveLength(1);
        expect(mocked.workspaceEditInserts[0].position.line).toBe(1);
        expect(mocked.workspaceEditInserts[0].text).toBe('    // @ai-ignore: 历史遗留\n');
        expect(saveMock).toHaveBeenCalledTimes(1);
        expect(syncAfterIssueIgnore).toHaveBeenCalledWith({ filePath: 'd:/ws/a.ts', insertedLine: 2 });
        expect(mocked.showInformationMessage).toHaveBeenCalledTimes(1);
    });

    it('python 文件应插入井号注释', async () => {
        getActiveIssueForActions.mockReturnValue({ file: 'd:/ws/a.py', line: 1 });
        mocked.showInputBox.mockResolvedValue('忽略');
        mocked.openTextDocument.mockResolvedValue({
            uri: { fsPath: 'd:/ws/a.py' },
            languageId: 'python',
            lineCount: 1,
            lineAt: () => ({ text: 'print(1)' }),
            getText: () => 'print(1)',
            save: saveMock,
        });
        mocked.applyEdit.mockResolvedValue(true);

        await runCommand();

        expect(mocked.workspaceEditInserts[0].text).toBe('# @ai-ignore: 忽略\n');
    });

    it('css 文件应插入块注释', async () => {
        getActiveIssueForActions.mockReturnValue({ file: 'd:/ws/a.css', line: 1 });
        mocked.showInputBox.mockResolvedValue('忽略');
        mocked.openTextDocument.mockResolvedValue({
            uri: { fsPath: 'd:/ws/a.css' },
            languageId: 'css',
            lineCount: 1,
            lineAt: () => ({ text: '  .a{color:red;}' }),
            getText: () => '.a{color:red;}',
            save: saveMock,
        });
        mocked.applyEdit.mockResolvedValue(true);

        await runCommand();

        expect(mocked.workspaceEditInserts[0].text).toBe('  /* @ai-ignore: 忽略 */\n');
    });

    it('vue script 块应使用双斜杠注释', async () => {
        getActiveIssueForActions.mockReturnValue({ file: 'd:/ws/a.vue', line: 5 });
        mocked.showInputBox.mockResolvedValue('忽略');
        mocked.openTextDocument.mockResolvedValue({
            uri: { fsPath: 'd:/ws/a.vue' },
            languageId: 'vue',
            lineCount: 6,
            lineAt: (index: number) => ({ text: index === 4 ? '  const a = 1;' : '' }),
            getText: () => '<template>\n<div/>\n</template>\n<script setup>\n  const a = 1;\n</script>',
            save: saveMock,
        });
        mocked.applyEdit.mockResolvedValue(true);

        await runCommand();

        expect(mocked.workspaceEditInserts[0].text).toBe('  // @ai-ignore: 忽略\n');
    });

    it('applyEdit 返回 false 时应报错且不保存不同步', async () => {
        getActiveIssueForActions.mockReturnValue({ file: 'd:/ws/a.ts', line: 1 });
        mocked.showInputBox.mockResolvedValue('忽略');
        mocked.openTextDocument.mockResolvedValue({
            uri: { fsPath: 'd:/ws/a.ts' },
            languageId: 'typescript',
            lineCount: 1,
            lineAt: () => ({ text: 'const a = 1;' }),
            getText: () => 'const a = 1;',
            save: saveMock,
        });
        mocked.applyEdit.mockResolvedValue(false);

        await runCommand();

        expect(mocked.showErrorMessage).toHaveBeenCalledTimes(1);
        expect(saveMock).not.toHaveBeenCalled();
        expect(syncAfterIssueIgnore).not.toHaveBeenCalled();
    });
});
