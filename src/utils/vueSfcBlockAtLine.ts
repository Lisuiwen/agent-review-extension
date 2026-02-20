/**
 * Vue SFC 按行解析：根据目标行所在块（template/script/style）返回等效的 languageId，
 * 用于放行注释等需要“按块选择注释格式”的场景。不依赖 vscode，纯函数。
 */

import { parse as parseSfc } from '@vue/compiler-sfc';

/** 判断行号 line（1-based）是否在 block 的 loc 范围内 */
const lineInBlock = (
    line: number,
    block: { loc?: { start?: { line: number }; end?: { line: number } } } | null
): boolean => {
    if (!block?.loc?.start?.line || block.loc.end?.line == null) return false;
    return line >= block.loc.start.line && line <= block.loc.end.line;
};

/**
 * 根据 Vue SFC 内容与目标行（1-based）返回该行所在块对应的 languageId。
 * 供放行命令在 vue 文件中插入注释时选用正确格式（template → html，script → js/ts，style → css/scss/less）。
 * 解析失败或行不在任何块内时返回 null，调用方应回退为 document.languageId（如 vue）。
 */
export const getEffectiveLanguageIdForVueAtLine = (
    content: string,
    line1Based: number
): string | null => {
    let descriptor: ReturnType<typeof parseSfc>['descriptor'];
    try {
        const result = parseSfc(content, { filename: 'anonymous.vue' });
        descriptor = result.descriptor;
    } catch {
        return null;
    }

    if (descriptor.template && lineInBlock(line1Based, descriptor.template)) return 'html';

    for (const script of [descriptor.script, descriptor.scriptSetup]) {
        if (script && lineInBlock(line1Based, script)) {
            const lang = (script as { lang?: string }).lang;
            return lang === 'ts' || lang === 'typescript' ? 'typescript' : 'javascript';
        }
    }

    const styles = descriptor.styles ?? [];
    for (const style of styles) {
        if (lineInBlock(line1Based, style)) {
            const lang = (style as { lang?: string }).lang;
            if (lang === 'scss' || lang === 'sass') return 'scss';
            if (lang === 'less') return 'less';
            return 'css';
        }
    }

    return null;
};
