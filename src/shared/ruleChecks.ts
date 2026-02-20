/**
 * 纯函数规则检查（无 VSCode 依赖）
 *
 * 供 core/ruleEngine 复用，保证规则实现一致。
 */

import * as path from 'path';
import type { ReviewIssue } from '../types/review';

const getSeverity = (action: string): 'error' | 'warning' | 'info' => {
    switch (action) {
        case 'block_commit':
            return 'error';
        case 'warning':
            return 'warning';
        case 'log':
            return 'info';
        default:
            return 'warning';
    }
};

/** 检查文件名是否包含空格 */
export const checkNoSpaceInFilename = (
    filePath: string,
    _content: string,
    options: { action: string }
): ReviewIssue[] => {
    const issues: ReviewIssue[] = [];
    const fileName = path.basename(filePath);
    if (fileName.includes(' ')) {
        issues.push({
            file: filePath,
            line: 1,
            column: 1,
            message: `文件名包含空格: ${fileName}`,
            rule: 'no_space_in_filename',
            severity: getSeverity(options.action),
        });
    }
    return issues;
};

/**
 * 检查 TODO/FIXME/XXX 等注释
 * @param changedLineNumbers - 若提供且非空，仅检查这些行号（1-based）；不传则检查全文件
 */
export const checkNoTodo = (
    filePath: string,
    content: string,
    options: { action: string; pattern?: string },
    changedLineNumbers?: Set<number>
): ReviewIssue[] => {
    const issues: ReviewIssue[] = [];
    const todoPattern = options.pattern || '(TODO|FIXME|XXX)';
    const todoRegex = new RegExp(todoPattern, 'i');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        if (changedLineNumbers && changedLineNumbers.size > 0 && !changedLineNumbers.has(lineNum)) {
            continue;
        }
        const lineContent = lines[i];
        const match = lineContent.match(todoRegex);
        if (match) {
            const column = lineContent.indexOf(match[0]) + 1;
            issues.push({
                file: filePath,
                line: lineNum,
                column,
                message: `发现 ${match[0]} 注释: ${lineContent.trim()}`,
                rule: 'no_todo',
                severity: getSeverity(options.action),
            });
        }
    }
    return issues;
};

/**
 * 检查 debugger 语句
 * @param changedLineNumbers - 若提供且非空，仅检查这些行号（1-based）；不传则检查全文件
 */
export const checkNoDebugger = (
    filePath: string,
    content: string,
    options: { action: string },
    changedLineNumbers?: Set<number>
): ReviewIssue[] => {
    const issues: ReviewIssue[] = [];
    const debuggerRegex = /\bdebugger\b\s*;?/;
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        if (changedLineNumbers && changedLineNumbers.size > 0 && !changedLineNumbers.has(lineNum)) {
            continue;
        }
        const lineContent = lines[i];
        const match = lineContent.match(debuggerRegex);
        if (!match) {
            continue;
        }
        const trimmed = lineContent.trim();
        if (trimmed.startsWith('//')) {
            continue;
        }
        const column = lineContent.indexOf(match[0]) + 1;
        issues.push({
            file: filePath,
            line: lineNum,
            column,
            message: `发现 debugger 语句: ${trimmed}`,
            rule: 'no_debugger',
            severity: getSeverity(options.action),
        });
    }
    return issues;
};
