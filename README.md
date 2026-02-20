# AgentReview

VSCode扩展插件，用于代码提交前的自动化代码审查。

## 功能特性

- 规则引擎：支持自定义业务规则检查
- AI审查：集成公司内部AI服务进行代码审查
- VSCode集成：拦截Source Control操作

## 迁移说明

- 已移除内置 Git Hook 管理能力，插件不再自动安装或管理 pre-commit hook。
- 若历史 `.agentreview.yaml` 中存在 `git_hooks` 配置段，请删除该配置段。

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

### 配置文件

在项目根目录创建 `.agentreview.yaml` 配置文件。详细配置示例请参考 `.agentreview.yaml.example`。

### 环境变量配置

支持通过 `.env` 文件配置敏感信息（如API密钥），避免将敏感信息提交到版本控制。

#### 使用步骤

1. **创建 `.env` 文件**
   在项目根目录创建 `.env` 文件（此文件已在 `.gitignore` 中排除，不会被提交）

2. **配置环境变量**
   在 `.env` 文件中添加你的环境变量，格式如下：
   ```env
   # OpenAI API 配置
   OPENAI_API_KEY=your_openai_api_key_here
   
   # 或其他AI服务API密钥
   AGENT_REVIEW_API_KEY=your_api_key_here
   ```

3. **在配置文件中引用**
   在 `.agentreview.yaml` 或 VSCode Settings 中使用 `${VAR_NAME}` 格式引用：
   ```yaml
   ai_review:
     api_key: "${OPENAI_API_KEY}"
   ```

#### 环境变量优先级

环境变量的查找优先级（从高到低）：
1. **系统环境变量**（`process.env`）- 优先级最高
2. **`.env` 文件** - 作为补充，不会覆盖系统环境变量
3. **未找到** - 保持原值（`${VAR_NAME}` 不会被替换）

#### `.env` 文件格式说明

- 支持 `KEY=value` 格式
- 支持引号包裹的值：`KEY="value with spaces"` 或 `KEY='value'`
- 支持注释：以 `#` 开头的行会被忽略
- 空行会被忽略
- 示例：
  ```env
  # 这是注释
  OPENAI_API_KEY=sk-1234567890abcdef
  API_ENDPOINT="https://api.example.com"
  TIMEOUT=30000
  ```

#### 注意事项

- `.env` 文件包含敏感信息，**不要提交到版本控制**
- 如果系统环境变量中已存在同名变量，`.env` 文件中的值会被忽略（系统环境变量优先级更高）
- 修改 `.env` 文件后，插件会自动重新加载配置
