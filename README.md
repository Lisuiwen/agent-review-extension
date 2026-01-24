# AgentReview

VSCode扩展插件，用于代码提交前的自动化代码审查。

## 功能特性

- 规则引擎：支持自定义业务规则检查
- AI审查：集成公司内部AI服务进行代码审查
- Git Hooks：自动安装pre-commit hook
- VSCode集成：拦截Source Control操作

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 监听模式（自动编译）
npm run watch
```

## 调试

### 方法一：使用VSCode调试（推荐）

1. **编译代码**
   ```bash
   npm run compile
   ```
   或者启动watch模式自动编译：
   ```bash
   npm run watch
   ```

2. **启动调试**
   - 按 `F5` 键，或点击左侧"运行和调试"面板
   - 选择"运行扩展"配置
   - 会打开一个新的VSCode窗口（Extension Development Host）

3. **在新窗口中测试**
   - 按 `Ctrl+Shift+P` 打开命令面板
   - 输入 `AgentReview: 执行代码审查` 执行命令
   - 查看输出日志：`视图` → `输出` → 选择"AgentReview"频道

4. **设置断点**
   - 在代码中点击行号左侧设置断点
   - 执行命令时会自动暂停，可以查看变量值

5. **查看日志**
   - 在调试窗口的"调试控制台"查看console输出
   - 在输出面板查看Logger日志

### 调试技巧

- **修改代码后**：watch模式会自动重新编译，按 `Ctrl+R` 在新窗口重新加载扩展
- **查看日志**：所有Logger输出都在"输出"面板的"AgentReview"频道
- **断点调试**：在关键位置设置断点，可以单步执行查看执行流程

## 配置

在项目根目录创建 `.agentreview.yaml` 配置文件。
