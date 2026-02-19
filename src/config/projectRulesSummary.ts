/**
 * 项目约定摘要（自然语言）
 *
 * 解析项目根目录下 .eslintrc.json / .prettierrc.json / tsconfig.json 等，
 * 输出短句供注入 AI System Prompt，不依赖 ESLint 运行时。
 */

import * as path from 'path';
import * as fs from 'fs';

/** 安全读 JSON，异常返回 null */
export const readJsonSafe = async (filePath: string): Promise<object | null> => {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const data = JSON.parse(content);
        return data && typeof data === 'object' ? data : null;
    } catch {
        return null;
    }
};

/** 从 ESLint rules 中提取 quotes/semi/indent 等转为短句 */
const summarizeEslintRules = (rules: Record<string, unknown>): string[] => {
    const out: string[] = [];
    if (!rules || typeof rules !== 'object') return out;

    const quotes = rules.quotes;
    if (Array.isArray(quotes)) {
        const mode = String(quotes[0] ?? '').toLowerCase();
        if (mode === 'single') out.push('使用单引号');
        else if (mode === 'double') out.push('使用双引号');
    }

    const semi = rules.semi;
    if (Array.isArray(semi)) {
        const mode = String(semi[0] ?? '').toLowerCase();
        if (mode === 'off' || mode === 'never') out.push('不使用分号');
        else if (mode === 'always') out.push('使用分号');
    }

    const indent = rules.indent;
    if (Array.isArray(indent)) {
        const val = indent[1] ?? indent[0];
        if (val === 'tab' || val === 2) out.push('缩进使用 2 空格或 Tab');
        else if (typeof val === 'number') out.push(`缩进 ${val} 空格`);
    }

    return out;
};

/** 从 .prettierrc.json 读 semi/singleQuote/tabWidth 转短句 */
const summarizePrettier = (obj: Record<string, unknown>): string[] => {
    const out: string[] = [];
    if (obj.semi === false) out.push('不使用分号');
    else if (obj.semi === true) out.push('使用分号');
    if (obj.singleQuote === true) out.push('使用单引号');
    if (typeof obj.tabWidth === 'number') out.push(`缩进 ${obj.tabWidth} 空格`);
    return out;
};

/**
 * 汇总项目根目录下配置为自然语言摘要，用换行连接；无配置或全失败返回 ''
 */
export const getProjectRulesSummary = async (workspaceRoot: string): Promise<string> => {
    const lines: string[] = [];

    const eslintPaths = ['.eslintrc.json', 'eslint.config.json'];
    for (const name of eslintPaths) {
        const p = path.join(workspaceRoot, name);
        if (!fs.existsSync(p)) continue;
        const data = await readJsonSafe(p);
        if (!data || typeof data !== 'object') continue;
        const rules = (data as { rules?: Record<string, unknown> }).rules;
        const part = summarizeEslintRules(rules ?? {});
        lines.push(...part);
        break; // 只取第一个存在的
    }

    const prettierPath = path.join(workspaceRoot, '.prettierrc.json');
    if (fs.existsSync(prettierPath)) {
        const data = await readJsonSafe(prettierPath);
        if (data && typeof data === 'object') {
            lines.push(...summarizePrettier(data as Record<string, unknown>));
        }
    }

    const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
        const data = await readJsonSafe(tsconfigPath);
        if (data && typeof data === 'object') {
            const opts = (data as { compilerOptions?: { strict?: boolean } }).compilerOptions;
            if (opts?.strict === true) lines.push('TypeScript 严格模式已开启');
        }
    }

    const unique = Array.from(new Set(lines));
    return unique.join('\n');
};
