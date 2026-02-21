import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
    existsSync: vi.fn(),
    readFile: vi.fn(),
}));

vi.mock('fs', () => ({
    existsSync: mocked.existsSync,
    promises: {
        readFile: mocked.readFile,
    },
}));

import { loadPluginYaml, loadYamlFromPath } from '../../config/configLoader';

describe('configLoader', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('loadYamlFromPath: 文件不存在时返回空对象', async () => {
        mocked.existsSync.mockReturnValue(false);
        const result = await loadYamlFromPath('d:/ws/.agentreview.yaml');
        expect(result).toEqual({});
    });

    it('loadYamlFromPath: 文件存在时应解析 YAML', async () => {
        mocked.existsSync.mockReturnValue(true);
        mocked.readFile.mockResolvedValue('ai_review:\n  enabled: true\n  run_on_save: true');

        const result = await loadYamlFromPath('d:/ws/.agentreview.yaml');
        expect(result).toEqual({
            ai_review: {
                enabled: true,
                run_on_save: true,
            },
        });
    });

    it('loadPluginYaml: 插件侧配置不存在时返回 null', async () => {
        mocked.existsSync.mockReturnValue(false);
        const result = await loadPluginYaml('d:/ext');
        expect(result).toBeNull();
    });

    it('loadPluginYaml: YAML 解析失败时返回 null', async () => {
        mocked.existsSync.mockReturnValue(true);
        mocked.readFile.mockResolvedValue('ai_review: [bad');

        const result = await loadPluginYaml('d:/ext');
        expect(result).toBeNull();
    });

    it('loadPluginYaml: 存在但无 ai_review 时返回 null', async () => {
        mocked.existsSync.mockReturnValue(true);
        mocked.readFile.mockResolvedValue('rules:\n  strict_mode: true');

        const result = await loadPluginYaml('d:/ext');
        expect(result).toBeNull();
    });

    it('loadPluginYaml: 存在且有 ai_review 时仅返回 ai_review', async () => {
        mocked.existsSync.mockReturnValue(true);
        mocked.readFile.mockResolvedValue('ai_review:\n  enabled: true\nruntime_log:\n  enabled: true');

        const result = await loadPluginYaml('d:/ext');
        expect(result).toEqual({
            ai_review: {
                enabled: true,
            },
        });
    });
});
