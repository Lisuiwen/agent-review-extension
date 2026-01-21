import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
// import { minimatch } from 'minimatch'; // TODO: 需要时取消注释并添加到package.json依赖
import { Logger } from './logger';

export class FileScanner {
    private logger: Logger;

    constructor() {
        this.logger = new Logger('FileScanner');
    }

    async getStagedFiles(): Promise<string[]> {
        // TODO: 获取Git staged文件列表
        this.logger.info('获取staged文件');
        return [];
    }

    async getChangedFiles(): Promise<string[]> {
        // TODO: 获取变更文件列表
        this.logger.info('获取变更文件');
        return [];
    }

    async readFile(filePath: string): Promise<string> {
        // TODO: 读取文件内容
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return content;
        } catch (error) {
            this.logger.error(`读取文件失败: ${filePath}`, error);
            throw error;
        }
    }

    shouldExclude(filePath: string, exclusions: { files?: string[]; directories?: string[] }): boolean {
        // TODO: 检查文件是否应该被排除
        if (!exclusions) {
            return false;
        }

        // 检查文件模式
        if (exclusions.files) {
            for (const pattern of exclusions.files) {
                // TODO: 使用minimatch进行模式匹配
                if (filePath.includes(pattern.replace(/\*\*/g, ''))) {
                    return true;
                }
            }
        }

        // 检查目录
        if (exclusions.directories) {
            for (const dir of exclusions.directories) {
                if (filePath.includes(dir)) {
                    return true;
                }
            }
        }

        return false;
    }
}
