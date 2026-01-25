import { defineConfig } from 'vitest/config';
import * as path from 'path';

/**
 * Vitest 配置文件
 * 
 * 用于配置单元测试环境，包括：
 * - TypeScript 支持
 * - 测试环境设置
 * - 覆盖率配置
 * - 路径别名（如需要）
 */
export default defineConfig({
    test: {
        // 测试环境：Node.js（因为 VSCode 扩展运行在 Node.js 环境中）
        environment: 'node',
        
        // 测试文件匹配模式
        include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
        
        // 排除的文件/目录
        exclude: ['node_modules', 'out', '.vscode-test'],
        
        // 全局设置（可以在测试文件中直接使用 describe、it、expect 等）
        globals: true,
        
        // 覆盖率配置
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/',
                'out/',
                'src/__tests__/',
                '**/*.test.ts',
                '**/*.spec.ts',
                '**/mocks/**',
                '**/helpers/**',
            ],
            // 覆盖率阈值
            thresholds: {
                lines: 75,
                functions: 75,
                branches: 70,
                statements: 75,
            },
        },
        
        // 测试超时时间（毫秒）
        testTimeout: 10000,
        
        // 设置测试文件中的模块解析
        setupFiles: ['./src/__tests__/setup.ts'],
    },
    
    // 路径解析配置
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            'vscode': path.resolve(__dirname, './src/__tests__/mocks/vscode.ts'),
        },
    },
});
