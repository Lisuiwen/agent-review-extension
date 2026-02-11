import { describe, expect, it } from 'vitest';
import type { AgentReviewConfig } from '../../types/config';
import { mergeConfig } from '../../config/configMerger';

const createBaseConfig = (): AgentReviewConfig => ({
    version: '1.0',
    rules: {
        enabled: true,
        strict_mode: false,
    },
    git_hooks: {
        auto_install: true,
        pre_commit_enabled: true,
    },
    exclusions: {
        files: [],
        directories: [],
    },
});

describe('configMerger runtime_log defaults', () => {
    it('应保持 auto_generate_on_run_end 默认值为 false', () => {
        const merged = mergeConfig(
            {
                ...createBaseConfig(),
                runtime_log: {
                    enabled: true,
                    level: 'info',
                    retention_days: 14,
                    file_mode: 'per_run',
                    format: 'jsonl',
                    base_dir_mode: 'workspace_docs_logs',
                    human_readable: {
                        enabled: true,
                        granularity: 'summary_with_key_events',
                        auto_generate_on_run_end: false,
                    },
                },
            },
            {},
            value => value
        );

        expect(merged.runtime_log?.human_readable?.auto_generate_on_run_end).toBe(false);
    });

    it('当 defaultConfig 未提供 runtime_log 时，回退默认值也应为 false', () => {
        const merged = mergeConfig(
            createBaseConfig(),
            {},
            value => value
        );

        expect(merged.runtime_log?.human_readable?.auto_generate_on_run_end).toBe(false);
    });
});
