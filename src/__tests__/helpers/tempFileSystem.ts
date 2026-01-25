/**
 * 临时文件系统工具
 * 
 * 提供创建和清理临时测试文件的工具函数
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);
const stat = promisify(fs.stat);

/**
 * 临时文件系统管理器
 * 用于在测试中创建和管理临时文件
 */
export class TempFileSystem {
    private tempDir: string;
    private files: string[] = [];
    private dirs: string[] = [];

    constructor(tempDir?: string) {
        // 使用系统临时目录或指定的目录
        // 使用更精确的时间戳和随机数避免并发冲突
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(7);
        this.tempDir = tempDir || path.join(require('os').tmpdir(), 'agentreview-test', `${timestamp}-${random}`);
    }

    /**
     * 初始化临时目录
     */
    async initialize(): Promise<void> {
        await mkdir(this.tempDir, { recursive: true });
        this.dirs.push(this.tempDir);
    }

    /**
     * 创建临时文件
     */
    async createFile(relativePath: string, content: string | Buffer): Promise<string> {
        const fullPath = path.join(this.tempDir, relativePath);
        const dir = path.dirname(fullPath);

        // 确保目录存在
        if (dir !== this.tempDir && !this.dirs.includes(dir)) {
            await mkdir(dir, { recursive: true });
            this.dirs.push(dir);
        }

        await writeFile(fullPath, content);
        this.files.push(fullPath);
        return fullPath;
    }

    /**
     * 创建二进制文件（用于测试二进制文件检测）
     */
    async createBinaryFile(relativePath: string, size: number = 100): Promise<string> {
        // 创建一个包含 null 字节的 buffer（用于模拟二进制文件）
        const buffer = Buffer.alloc(size);
        buffer.fill(0); // 填充 null 字节
        return this.createFile(relativePath, buffer);
    }

    /**
     * 创建大文件（用于测试大文件跳过）
     */
    async createLargeFile(relativePath: string, sizeInBytes: number): Promise<string> {
        const buffer = Buffer.alloc(sizeInBytes);
        buffer.fill('A'.charCodeAt(0)); // 填充 'A' 字符
        return this.createFile(relativePath, buffer);
    }

    /**
     * 读取文件内容
     */
    async readFile(relativePath: string): Promise<string> {
        const fullPath = path.join(this.tempDir, relativePath);
        return readFile(fullPath, 'utf-8');
    }

    /**
     * 获取文件路径
     */
    getPath(relativePath: string): string {
        return path.join(this.tempDir, relativePath);
    }

    /**
     * 获取临时目录路径
     */
    getTempDir(): string {
        return this.tempDir;
    }

    /**
     * 检查文件是否存在
     */
    async fileExists(relativePath: string): Promise<boolean> {
        try {
            const fullPath = path.join(this.tempDir, relativePath);
            await stat(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 清理所有临时文件
     */
    async cleanup(): Promise<void> {
        // 删除所有文件
        for (const file of this.files) {
            try {
                await unlink(file);
            } catch (error) {
                // 忽略删除失败（文件可能已被删除）
            }
        }

        // 删除所有目录（从最深到最浅）
        const sortedDirs = [...this.dirs].sort((a, b) => b.length - a.length);
        for (const dir of sortedDirs) {
            try {
                await rmdir(dir);
            } catch (error) {
                // 忽略删除失败（目录可能不为空或已被删除）
            }
        }

        this.files = [];
        this.dirs = [];
    }
}

/**
 * 创建临时文件系统的辅助函数
 */
export const createTempFileSystem = async (tempDir?: string): Promise<TempFileSystem> => {
    const tfs = new TempFileSystem(tempDir);
    await tfs.initialize();
    return tfs;
};
