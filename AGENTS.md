# AgentReview - AI 代码审查助手

## 项目概述

AgentReview 是一个 VSCode 扩展，提供代码审查功能，支持规则检查和 AI 审查，在 commit 时强制执行。该项目使用 TypeScript 开发，遵循 VSCode 扩展开发最佳实践。

## 构建和开发命令

### 核心命令
```bash
# 编译 TypeScript 代码
npm run compile

# 监听模式编译（开发时使用）
npm run watch

# 预发布编译（VSCode 市场发布前）
npm run vscode:prepublish
```

### 测试命令
```bash
# 注意：当前项目暂无测试配置
# 建议添加以下测试命令：
npm test                    # 运行所有测试
npm run test:unit          # 运行单元测试
npm run test:integration   # 运行集成测试
npm run test:single <file> # 运行单个测试文件
```

### 调试和开发
```bash
# 在 VSCode 中按 F5 启动调试
# 或使用命令面板 "Debug: Start Debugging"
```

## 代码风格指南

### TypeScript 配置
- 目标版本：ES2020
- 模块系统：CommonJS
- 严格模式：启用 (`strict: true`)
- 输出目录：`out/`
- 源码目录：`src/`

### 导入规范
```typescript
// 1. VSCode 模块导入（最优先）
import * as vscode from 'vscode';

// 2. 第三方库导入
import axios from 'axios';
import * as yaml from 'js-yaml';

// 3. 内部模块导入（按相对路径层级）
import { ConfigManager } from './config/configManager';
import { Logger } from '../utils/logger';
```

### 命名约定
```typescript
// 类名：PascalCase
export class ReviewEngine {
    private ruleEngine: RuleEngine;
    private configManager: ConfigManager;
}

// 接口名：PascalCase，以 I 开头（可选）
export interface ReviewResult {
    passed: boolean;
    errors: ReviewIssue[];
}

// 变量和函数：camelCase
const reviewEngine = new ReviewEngine();
const stagedFiles = await getStagedFiles();

// 常量：SCREAMING_SNAKE_CASE
const DEFAULT_CONFIG_PATH = '.agentreview.yaml';
const MAX_RETRY_COUNT = 3;

// 文件名：camelCase
reviewEngine.ts
configManager.ts
aiReviewer.ts
```

### 错误处理
```typescript
// 1. 使用 try-catch 包装异步操作
try {
    const result = await reviewEngine.review(files);
    return result;
} catch (error) {
    logger.error('审查失败', error);
    throw new Error(`代码审查失败: ${error.message}`);
}

// 2. 返回错误结果而非抛出异常（对于非致命错误）
if (config.ai_review?.enabled) {
    try {
        aiIssues = await this.aiReviewer.review(aiRequest);
    } catch (error) {
        logger.error('AI审查失败', error);
        // 记录错误但不阻塞流程
    }
}

// 3. 使用自定义错误类型
export class ReviewError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly file?: string
    ) {
        super(message);
        this.name = 'ReviewError';
    }
}
```

### 注释规范
```typescript
/**
 * 审查引擎
 * 
 * 这是整个插件的核心组件，负责协调各个子系统完成代码审查
 * 
 * 主要职责：
 * 1. 接收文件列表，执行代码审查
 * 2. 调用规则引擎检查代码问题
 * 3. 根据配置决定是否阻止提交
 * 4. 返回结构化的审查结果
 * 
 * 工作流程：
 * 1. 获取需要审查的文件列表（通常是 git staged 文件）
 * 2. 根据配置过滤掉排除的文件
 * 3. 调用规则引擎检查每个文件
 * 4. 将问题按严重程度分类（error/warning/info）
 * 5. 根据配置判断是否通过审查
 */
export class ReviewEngine {
    /**
     * 审查指定的文件列表
     * 
     * 这是核心审查方法，执行以下步骤：
     * 1. 过滤排除的文件
     * 2. 调用规则引擎检查每个文件
     * 3. 按严重程度分类问题
     * 4. 根据配置判断是否通过
     * 
     * @param files - 要审查的文件路径数组
     * @returns 审查结果对象
     */
    async review(files: string[]): Promise<ReviewResult> {
        // 实现代码...
    }
}
```

### 代码组织
```typescript
// 1. 文件顶部：导入语句
import * as vscode from 'vscode';
import { RuleEngine } from './ruleEngine';
import { Logger } from '../utils/logger';

// 2. 接口和类型定义
export interface ReviewResult {
    passed: boolean;
    errors: ReviewIssue[];
}

// 3. 类定义
export class ReviewEngine {
    // 4. 静态属性和方法
    private static readonly DEFAULT_TIMEOUT = 30000;

    // 5. 实例属性
    private ruleEngine: RuleEngine;
    private logger: Logger;

    // 6. 构造函数
    constructor(configManager: ConfigManager) {
        // 初始化代码...
    }

    // 7. 公共方法
    async review(files: string[]): Promise<ReviewResult> {
        // 实现代码...
    }

    // 8. 私有方法
    private async filterFiles(files: string[]): Promise<string[]> {
        // 实现代码...
    }
}
```

### 异步编程
```typescript
// 1. 始终使用 async/await 而非 Promise.then()
async reviewStagedFiles(): Promise<ReviewResult> {
    const stagedFiles = await this.fileScanner.getStagedFiles();
    return this.review(stagedFiles);
}

// 2. 并行执行多个异步操作
const [ruleIssues, aiIssues] = await Promise.all([
    this.ruleEngine.checkFiles(files),
    this.aiReviewer.review(aiRequest)
]);

// 3. 错误处理要包含在 try-catch 中
try {
    const result = await this.review(files);
    return result;
} catch (error) {
    this.logger.error('审查失败', error);
    throw error;
}
```

### 日志记录
```typescript
// 1. 每个类都应该有 Logger 实例
export class ReviewEngine {
    private logger: Logger;

    constructor(configManager: ConfigManager) {
        this.logger = new Logger('ReviewEngine');
    }
}

// 2. 关键操作都要记录日志
this.logger.info(`开始审查 ${files.length} 个文件`);
this.logger.error('AI审查失败', error);
this.logger.warn('配置文件不存在，使用默认配置');

// 3. 日志级别使用指南
// - info: 正常流程、关键操作
// - warn: 可恢复的问题、降级处理
// - error: 错误和异常
// - debug: 详细调试信息（仅在开发时使用）
```

## 项目结构

```
src/
├── extension.ts           # 扩展入口点
├── core/                  # 核心业务逻辑
│   ├── reviewEngine.ts    # 审查引擎
│   ├── ruleEngine.ts      # 规则引擎
│   └── aiReviewer.ts      # AI 审查器
├── config/                # 配置管理
│   └── configManager.ts   # 配置管理器
├── hooks/                 # Git Hooks
│   ├── gitHookManager.ts  # Git Hook 管理器
│   └── hookRunner.ts      # Hook 执行器
├── ui/                    # 用户界面
│   ├── reviewPanel.ts     # 审查结果面板
│   └── statusBar.ts       # 状态栏
└── utils/                 # 工具类
    ├── fileScanner.ts     # 文件扫描器
    └── logger.ts          # 日志记录器
```

## 开发注意事项

### 1. VSCode 扩展开发规范
- 所有资源必须注册到 `context.subscriptions`
- 使用 `vscode.Disposable` 模式管理资源
- 遵循命令注册模式：`vscode.commands.registerCommand`

### 2. 错误处理原则
- 非致命错误不应阻塞用户操作
- AI 审查失败时提供降级方案
- 所有错误都要记录到日志

### 3. 性能考虑
- 大文件处理要考虑内存使用
- AI 调用要设置合理的超时时间
- 文件扫描要支持排除规则

### 4. 配置管理
- 支持热重载配置文件
- 提供合理的默认值
- 配置验证和错误提示

## 特殊规则（来自 .cursorrules）

1. **新手友好注释**：每个关键文件都需要详细注释，指导新手程序员理解代码
2. **注释同步更新**：AI 更新代码后必须同步更新对应注释
3. **版本迭代控制**：所有开发都要围绕 `.cursor/plans/phase1-mvp.md` 的需求，超出范围的需求必须更新该文件

## AI 代码审查指南

当使用 AI 工具（如 Cursor、Copilot）开发此项目时：

1. **保持注释风格一致**：遵循现有的详细注释风格
2. **错误处理优先**：确保所有异步操作都有适当的错误处理
3. **类型安全**：充分利用 TypeScript 的类型系统
4. **资源管理**：VSCode 扩展中的资源要正确释放
5. **向后兼容**：API 变更要考虑向后兼容性

## 调试和故障排除

1. **查看日志**：使用 "View -> Output -> AgentReview" 查看详细日志
2. **调试模式**：按 F5 启动扩展开发主机进行调试
3. **配置验证**：检查 `.agentreview.yaml` 配置文件格式
4. **Git Hooks**：确保 Git hooks 正确安装且有执行权限


##其他
必须使用中文回复问答