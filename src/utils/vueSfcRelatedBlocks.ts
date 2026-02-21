/**
 * Vue SFC 相关块上下文：根据主审片段所在块，返回同文件内「另一块」内容（仅 template ↔ script，不送 style），
 * 供 AI 参考以减少误报（如模板已有 v-if 仍报 user 判空）。纯函数、无 I/O。
 */

import { parse as parseSfc } from '@vue/compiler-sfc';

export interface VueSfcRelatedBlocksOptions {
    /** 当前送审的 AST 片段涉及的行号（1-based，源文件行号） */
    snippetLines: number[];
    /** 附带块最大行数，超出则只取前 N 行并注明截断 */
    maxLines: number;
}

export interface VueSfcRelatedBlocksResult {
    template?: string;
    script?: string;
    /** 附带块在源文件中的行范围（1-based [start, end]），供 hover 展示用 */
    templateRange?: [number, number];
    scriptRange?: [number, number];
}

const blockLoc = (block: { loc?: { start?: { line: number }; end?: { line: number } } } | null) =>
    block?.loc?.start?.line != null && block.loc?.end?.line != null
        ? { start: block.loc.start.line, end: block.loc.end.line }
        : null;

/** 行号 line 是否落在 [start, end] 内 */
const lineInRange = (line: number, start: number, end: number) => line >= start && line <= end;

/**
 * 从 SFC 中取出与主审片段「不同块」的内容：主审在 script 则返回 template，主审在 template 则返回 script。
 * 不处理、不返回 style，以节省 token。
 *
 * @param content - 整份 .vue 文件内容
 * @param options - snippetLines（主审涉及行号）、maxLines（单块最大行数）
 * @returns 若解析失败返回 {}；否则返回需要附带的块（带行号前缀与截断说明）
 */
export const getVueSfcRelatedBlocksForContext = (
    content: string,
    options: VueSfcRelatedBlocksOptions
): VueSfcRelatedBlocksResult => {
    const { snippetLines, maxLines } = options;
    if (snippetLines.length === 0 || maxLines <= 0) return {};

    let descriptor: ReturnType<typeof parseSfc>['descriptor'];
    try {
        const result = parseSfc(content, { filename: 'anonymous.vue' });
        descriptor = result.descriptor;
    } catch {
        return {};
    }

    const lines = content.split('\n');
    const templateLoc = blockLoc(descriptor.template ?? null);
    const scriptLoc = blockLoc(descriptor.script ?? null);
    const scriptSetupLoc = blockLoc(descriptor.scriptSetup ?? null);

    /** 主审是否落在 template 块内 */
    const mainIsTemplate =
        templateLoc && snippetLines.some((line) => lineInRange(line, templateLoc.start, templateLoc.end));
    /** 主审是否落在 script 或 scriptSetup 块内 */
    const mainIsScript =
        (scriptLoc && snippetLines.some((line) => lineInRange(line, scriptLoc.start, scriptLoc.end))) ||
        (scriptSetupLoc && snippetLines.some((line) => lineInRange(line, scriptSetupLoc.start, scriptSetupLoc.end)));

    const out: VueSfcRelatedBlocksResult = {};

    if (mainIsScript && templateLoc) {
        out.templateRange = [templateLoc.start, templateLoc.end];
        const blockLines = lines.slice(templateLoc.start - 1, templateLoc.end);
        const capped = blockLines.length > maxLines ? blockLines.slice(0, maxLines) : blockLines;
        const withLineNum = capped.map((line, i) => `# 行 ${templateLoc.start + i}\n${line}`).join('\n');
        const truncatedNote =
            blockLines.length > maxLines ? `\n（前 ${maxLines} 行，已截断）` : '';
        out.template = `同一 SFC 的 template（供参考）\n${withLineNum}${truncatedNote}`;
    }

    if (mainIsTemplate && (scriptSetupLoc || scriptLoc)) {
        const loc = scriptSetupLoc ?? scriptLoc!;
        out.scriptRange = [loc.start, loc.end];
        const blockLines = lines.slice(loc.start - 1, loc.end);
        const capped = blockLines.length > maxLines ? blockLines.slice(0, maxLines) : blockLines;
        const withLineNum = capped.map((line, i) => `# 行 ${loc.start + i}\n${line}`).join('\n');
        const truncatedNote =
            blockLines.length > maxLines ? `\n（前 ${maxLines} 行，已截断）` : '';
        out.script = `同一 SFC 的 script（供参考）\n${withLineNum}${truncatedNote}`;
    }

    return out;
};
