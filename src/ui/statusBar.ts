/**
 * 状态栏管理
 * 
 * 这个文件实现了 VSCode 状态栏的显示逻辑，用于在编辑器底部状态栏显示代码审查的状态和结果
 * 
 * 主要功能：
 * 1. 显示审查状态：就绪、审查中、错误、警告等
 * 2. 显示审查结果统计：错误数量、警告数量、信息数量
 * 3. 提供快速访问：点击状态栏项可打开审查报告
 * 
 * 状态类型：
 * - ready: 就绪状态，显示检查图标
 * - reviewing: 审查中，显示旋转图标
 * - error: 审查失败，显示错误图标
 * - warning: 审查发现问题，根据问题类型显示不同图标和统计信息
 * 
 * 使用方式：
 * ```typescript
 * const statusBar = new StatusBar();
 * statusBar.updateStatus('reviewing');
 * statusBar.updateWithResult(reviewResult);
 * statusBar.dispose(); // 清理资源
 * ```
 */

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ReviewResult } from '../core/reviewEngine';

/**
 * 状态栏管理类
 * 
 * 负责管理 VSCode 状态栏中的 AgentReview 状态显示
 * 状态栏位于编辑器底部右侧，显示审查状态和结果统计
 */
export class StatusBar {
    /** VSCode 状态栏项实例 */
    private statusBarItem: vscode.StatusBarItem;
    /** 日志记录器 */
    private logger: Logger;
    /** 最近一次的子状态文案（例如“排队中/限频中/已丢弃过期结果”） */
    private subStatusMessage = '';

    /**
     * 构造函数
     * 
     * 初始化状态栏项，设置位置、优先级和点击命令
     * 状态栏默认显示为"就绪"状态
     */
    constructor() {
        this.logger = new Logger('StatusBar');
        
        // 创建状态栏项，位于右侧，优先级为 100
        // 优先级数字越小，位置越靠右
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        
        // 设置点击命令：点击状态栏项时打开审查报告
        this.statusBarItem.command = 'agentreview.showReport';
        
        // 初始状态为"就绪"
        this.updateStatus('ready');
    }

    /**
     * 更新状态栏显示
     * 
     * 根据不同的状态类型显示相应的图标和文本
     * 
     * @param status - 状态类型
     *   - 'ready': 就绪状态，显示检查图标
     *   - 'reviewing': 审查中，显示旋转图标
     *   - 'error': 审查失败，显示错误图标
     *   - 'warning': 审查发现问题，根据结果显示统计信息
     * @param result - 可选的审查结果，当 status 为 'warning' 时用于显示详细统计
     * 
     * 状态栏显示规则：
     * - ready: 显示 "✓ AgentReview"，提示"AgentReview 就绪"
     * - reviewing: 显示旋转图标 "⟳ AgentReview"，提示"正在审查..."
     * - error: 显示 "✗ AgentReview"，提示"审查失败"
     * - warning: 根据结果中的问题数量显示：
     *   - 有错误：显示 "✗ AgentReview: N个错误"，提示详细统计
     *   - 有警告：显示 "⚠ AgentReview: N个警告"，提示详细统计
     *   - 无问题：显示 "✓ AgentReview: 通过"，提示"审查通过"
     */
    updateStatus(
        status: 'ready' | 'reviewing' | 'error' | 'warning',
        result?: ReviewResult,
        subStatus?: string
    ): void {
        this.subStatusMessage = subStatus ?? '';
        switch (status) {
            case 'ready':
                // 就绪状态：显示检查图标
                this.statusBarItem.text = '$(check) AgentReview';
                this.statusBarItem.tooltip = 'AgentReview 就绪';
                break;
                
            case 'reviewing':
                // 审查中：显示旋转图标，表示正在处理
                this.statusBarItem.text = '$(sync~spin) AgentReview';
                this.statusBarItem.tooltip = '正在审查...';
                break;
                
            case 'error':
                // 审查失败：显示错误图标
                this.statusBarItem.text = '$(error) AgentReview';
                this.statusBarItem.tooltip = '审查失败';
                break;
                
            case 'warning':
                // 审查发现问题：根据问题类型和数量显示不同的信息
                if (result) {
                    const errorCount = result.errors.length;
                    const warningCount = result.warnings.length;
                    const infoCount = result.info.length;
                    
                    if (errorCount > 0) {
                        // 有错误：优先显示错误数量
                        this.statusBarItem.text = `$(error) AgentReview: ${errorCount}个错误`;
                        this.statusBarItem.tooltip = `审查发现问题: ${errorCount}个错误, ${warningCount}个警告, ${infoCount}个信息`;
                    } else if (warningCount > 0) {
                        // 有警告：显示警告数量
                        this.statusBarItem.text = `$(warning) AgentReview: ${warningCount}个警告`;
                        this.statusBarItem.tooltip = `审查发现警告: ${warningCount}个警告, ${infoCount}个信息`;
                    } else {
                        // 无错误和警告：显示通过
                        this.statusBarItem.text = '$(check) AgentReview: 通过';
                        this.statusBarItem.tooltip = '审查通过';
                    }
                } else {
                    // 没有结果对象：显示通用警告
                    this.statusBarItem.text = '$(warning) AgentReview';
                    this.statusBarItem.tooltip = '审查有警告';
                }
                break;
        }

        if (this.subStatusMessage) {
            this.statusBarItem.tooltip = `${this.statusBarItem.tooltip}\n${this.subStatusMessage}`;
        }
        
        // 显示状态栏项
        this.statusBarItem.show();
    }

    /**
     * 根据审查结果更新状态栏：通过且无任何问题显示 ready，否则显示 warning（含问题统计）。
     */
    updateWithResult(result: ReviewResult, subStatus?: string): void {
        const hasAnyIssues =
            result.errors.length > 0 || result.warnings.length > 0 || result.info.length > 0;
        if (result.passed && !hasAnyIssues) {
            this.updateStatus('ready', undefined, subStatus);
        } else {
            this.updateStatus('warning', result, subStatus);
        }
    }

    /**
     * 清理资源
     * 
     * 释放状态栏项占用的资源
     * 在扩展停用或不再需要状态栏时调用
     */
    dispose(): void {
        this.statusBarItem.dispose();
    }
}
