# AgentReview 项目架构与数据流转

本文档描述 VSCode 插件 AgentReview 的整体架构、数据流转与功能细节，便于新人快速理解项目。

---

## 一、项目概述

**AgentReview** 是一款在 **commit 时强制执行** 的代码审查插件，支持：

- **规则检查**：内置规则（如文件名空格、TODO 注释等），可配置为阻止提交 / 警告 / 仅记录
- **AI 审查**：调用 OpenAI 兼容 API 对变更代码做审查，支持按文件或按 AST 片段分批、增量（仅审查变更）
- **Git Hooks**：pre-commit 时自动跑审查，未通过可阻止提交；支持「本次放行提交」
- **运行链路日志**：JSONL 落盘 + 可读摘要，便于排查与优化

技术栈：TypeScript、VSCode Extension API、Node.js；依赖包括 `js-yaml`、`axios`、`zod`、`minimatch`、`@babel/parser`、`@vue/compiler-sfc` 等。

---

## 二、目录与模块划分

```
AgentReview/
├── src/
│   ├── extension.ts              # 插件入口：激活/停用、初始化、注册命令
│   ├── types/                    # 类型定义（无业务逻辑）
│   │   ├── config.ts             # AgentReviewConfig、RuleConfig
│   │   ├── review.ts             # ReviewIssue、ReviewResult
│   │   └── diff.ts               # FileDiff、DiffHunk
│   ├── config/                   # 配置加载与合并
│   │   ├── configManager.ts      # 配置管理器（YAML + Settings + .env）
│   │   ├── configLoader.ts       # 读 YAML、插件侧默认
│   │   ├── configMerger.ts       # 默认 + 用户配置合并
│   │   ├── configWatcher.ts     # 配置/.env 变更监听与防抖重载
│   │   └── envResolver.ts       # 环境变量占位符解析
│   ├── core/                     # 审查核心
│   │   ├── reviewEngine.ts       # 审查引擎：协调规则 + AI，产出 ReviewResult
│   │   ├── ruleEngine.ts         # 规则引擎：对文件执行内置规则
│   │   └── issueDeduplicator.ts  # 规则与 AI 问题合并去重
│   ├── ai/                       # AI 审查
│   │   ├── aiReviewer.ts         # AI 审查器：分批、请求、解析
│   │   └── aiRetryHandler.ts    # 重试与超时
│   ├── shared/                   # 无 VSCode 依赖，供扩展与 hook 共用
│   │   ├── ruleChecks.ts         # 纯函数：no_space_in_filename、no_todo
│   │   ├── standaloneConfigLoader.ts  # 独立加载配置（hook 用）
│   │   └── standaloneFileScanner.ts   # 独立获取 staged 文件（hook 用）
│   ├── hooks/
│   │   ├── gitHookManager.ts     # 安装/卸载/检测 pre-commit hook
│   │   └── hookRunner.ts         # 独立脚本：在 hook 中跑规则审查（无 AI）
│   ├── ui/
│   │   ├── reviewPanel.ts        # 侧边栏「审查结果」TreeView
│   │   └── statusBar.ts         # 状态栏
│   ├── commands/                 # 命令实现
│   │   ├── commandContext.ts     # 命令依赖注入
│   │   ├── runReviewCommand.ts   # agentreview.run
│   │   ├── reviewCommand.ts     # agentreview.review
│   │   ├── showReportCommand.ts  # 显示报告
│   │   ├── installHooksCommand.ts
│   │   ├── allowIssueIgnoreCommand.ts
│   │   ├── fixIssueCommand.ts
│   │   ├── refreshCommand.ts
│   │   └── explainRuntimeLogCommand.ts
│   └── utils/
│       ├── fileScanner.ts        # 获取 staged 文件、staged diff、读文件、排除逻辑
│       ├── diffParser.ts         # 解析 git diff 统一格式
│       ├── diffTypes.ts          # re-export FileDiff 等
│       ├── astScope.ts           # 根据 diff 计算受影响的 AST 片段（JS/TS/Vue）
│       ├── logger.ts
│       ├── runtimeTraceLogger.ts # 运行链路 JSONL 日志
│       ├── runtimeLogPath.ts     # 日志目录解析（工作区 docs/logs 或全局）
│       └── runtimeLogExplainer.ts # 可读摘要生成
├── package.json                  # 扩展清单、命令、配置项、视图
└── docs/
```

- **入口**：`extension.ts` 在 `onStartupFinished` 激活，创建 ConfigManager、ReviewEngine、GitHookManager、ReviewPanel、StatusBar，并注册所有命令与视图。
- **核心**：`ReviewEngine` 依赖 `ConfigManager`、`RuleEngine`、`AIReviewer`、`FileScanner`、`IssueDeduplicator`，是「一次审查」的编排者。
- **无 VSCode 环境**：`shared/` + `hooks/hookRunner.ts` 用于 Git pre-commit 时在 Node 进程中独立跑规则审查（不调 AI、不依赖 VSCode API）。

---

## 三、架构总览（分层与依赖）

```
                    ┌─────────────────────────────────────────────────┐
                    │  VSCode 层（extension、commands、ui）             │
                    │  extension.ts → CommandContext → 各 command       │
                    └───────────────────────┬─────────────────────────┘
                                            │
                    ┌───────────────────────▼─────────────────────────┐
                    │  核心层（core）                                   │
                    │  ReviewEngine ← RuleEngine, AIReviewer,          │
                    │  FileScanner, IssueDeduplicator, RuntimeTraceLogger │
                    └───────────────────────┬─────────────────────────┘
                                            │
        ┌───────────────────────────────────┼───────────────────────────────────┐
        │                   │               │               │                     │
        ▼                   ▼               ▼               ▼                     ▼
┌───────────────┐  ┌───────────────┐ ┌───────────┐ ┌───────────────┐  ┌─────────────────┐
│ ConfigManager │  │ FileScanner    │ │ RuleEngine│ │ AIReviewer    │  │ RuntimeTraceLogger│
│ config/       │  │ utils/        │ │ core/     │ │ ai/           │  │ utils/          │
└───────┬───────┘  └───────┬───────┘ └─────┬─────┘ └───────┬───────┘  └─────────────────┘
        │                  │               │               │
        │                  │               │               │
        ▼                  ▼               ▼               ▼
┌───────────────┐  ┌───────────────┐ ┌───────────┐ ┌───────────────┐
│ configLoader  │  │ diffParser     │ │ ruleChecks│ │ axios / zod    │
│ configMerger  │  │ astScope       │ │ (shared)  │ │ aiRetryHandler │
│ envResolver   │  │ (git diff)     │ │           │ │                │
└───────────────┘  └───────────────┘ └───────────┘ └───────────────┘
```

- **配置**：ConfigManager 合并「默认 + .agentreview.yaml + VSCode Settings + .env」，供 ReviewEngine、RuleEngine、AIReviewer、RuntimeTraceLogger 使用。
- **文件与 Diff**：FileScanner 通过 `git diff --cached` 拿 staged 文件列表和每文件 diff；diffParser 解析为 `FileDiff`（hunks）；astScope 在启用 AST 时按 diff 行号算出受影响片段（供 AI 按片段发送）。
- **规则**：RuleEngine 读配置后对每个文件调用 shared/ruleChecks（no_space_in_filename、no_todo），有 diff 时 no_todo 仅扫变更行。
- **AI**：AIReviewer 按配置做分批（按文件数或按 AST 片段数）、并发、超时与重试，请求体为 OpenAI 兼容格式，响应用 zod 校验后转成 ReviewIssue。
- **去重**：IssueDeduplicator 对「规则 + AI + AI 错误」合并去重（文件:行:列:标准化消息），同键保留更高严重度。
- **运行日志**：RuntimeTraceLogger 单例，按 runId 写 JSONL；ReviewEngine 在关键阶段/事件打点，可选生成可读摘要。

---

## 四、数据流转

### 4.1 手动执行审查（命令 `agentreview.run`）

1. 用户执行「执行代码审查」→ `runReviewCommand` 被调用。
2. 更新 UI：StatusBar = reviewing，ReviewPanel 显示 reviewing并 reveal。
3. 调用 `reviewEngine.reviewStagedFiles()`：
   - 若未配置 diff，仅用 `fileScanner.getStagedFiles()` 得到文件列表；
   - 若配置需要 diff（默认）：再调 `fileScanner.getStagedDiff(stagedFiles)` 得到 `Map<path, FileDiff>`。
   - 启动一次 RuntimeTraceSession（trigger=staged），打点 run_start、config_snapshot、file_filter_summary、diff_fetch_summary 等。
4. `reviewEngine.review(files, { diffByFile, traceSession })` 内部：
   - 按 exclusions 过滤文件；
   - 若启用 AST：对每个有 diff 的文件用 astScope 算受影响片段，打点 ast_scope_summary；
   - 若启用内置规则：`ruleEngine.checkFiles(filteredFiles, diffByFile, traceSession)` → 得到 ruleIssues；
   - 若启用 AI：根据配置决定是否在「已有阻止提交错误」时跳过 AI；不跳过则 `aiReviewer.review(...)` → aiIssues（失败时推入 aiErrorIssues）；
   - `IssueDeduplicator.mergeAndDeduplicate(ruleIssues, aiIssues, aiErrorIssues)` → 合并去重；
   - 根据 rule/action 将 issue 分到 errors/warnings/info，并判断 passed（strict_mode 下 errors.length===0，否则看是否有 action===block_commit 的 error）；
   - 打点 run_end，可选生成可读摘要，结束 session。
5. 结果回传：`reviewPanel.showReviewResult(result)` 更新 TreeView；`statusBar.updateWithResult(result)`；根据 passed 与 errors/warnings 弹出提示。

数据流小结：**命令 → ReviewEngine.reviewStagedFiles → getStagedFiles + getStagedDiff → review(过滤、规则、AI、去重、passed) → ReviewResult → Panel + StatusBar + 通知**。

### 4.2 Git pre-commit 时（Hook 路径）

1. 用户执行 `git commit` → Git 执行 `.git/hooks/pre-commit`。
2. pre-commit 由 GitHookManager 生成，设置 `WORKSPACE_ROOT`，用 Node 执行 `out/hooks/hookRunner.js`。
3. hookRunner（无 VSCode）：
   - 用 `standaloneConfigLoader.loadStandaloneConfig(workspaceRoot)` 读 .agentreview.yaml（及默认）；
   - `standaloneFileScanner.getStagedFiles(workspaceRoot)` 得到 staged 列表，按 exclusions 过滤；
   - 若 `builtin_rules_enabled` 且 rules.enabled，对每个文件读内容，调用 shared/ruleChecks（no_space_in_filename、no_todo），不读 diff（即全文件扫 no_todo）；
   - 按 severity 分 errors/warnings，若有 error 且对应 rule 的 action 为 block_commit（或 strict_mode），则打印错误并 exit(1)，否则 exit(0)。

此路径**不经过 VSCode、不调 AI、不写运行链路日志**，只做规则审查。

### 4.3 配置加载与优先级

1. **ConfigManager.initialize**：loadEnvFile（多工作区 .env + 可选扩展目录 .env）→ loadConfig → setupFileWatcher。
2. **loadConfig**：  
   - getDefaultConfig() 作为基底；  
   - loadYamlFromPath(configPath) 读工作区 .agentreview.yaml；  
   - 若无 ai_review 则尝试 loadPluginYaml(extensionPath) 从插件目录取默认；  
   - loadAIConfigFromSettings() / loadRuntimeLogConfigFromSettings() 从 VSCode Settings 取（显式配置优先）；  
   - resolveEnvInConfig 解析 YAML 中的环境变量占位符；  
   - mergeConfig(default, resolvedUser, resolveEnv) 得到最终配置。
3. 优先级：**VSCode Settings > .agentreview.yaml > 插件默认 YAML > 代码内默认**；.env 用于占位符如 `${AGENTREVIEW_AI_API_ENDPOINT}`。
4. 配置或 .env 变更时，configWatcher 防抖触发 reloadConfig，失败则保留旧配置并提示。

### 4.4 运行链路日志

- **RuntimeTraceLogger** 单例，initialize(baseDir, config) 时确定是否启用、级别、保留天数、是否每 run 一文件等。
- **Session**：每次 reviewStagedFiles 或 review(manual) 会 startRunSession，得到 runId、trigger；结束 endRunSession。
- **写盘**：logEvent({ session, component, event, phase, data }) 按级别过滤后追加 JSONL；flush/end 时保证写入。
- **目录**：由 runtimeLogPath.resolveRuntimeLogBaseDir 根据 base_dir_mode 决定是工作区 `docs/logs/runtime-logs` 还是 VSCode globalStorage。
- **可读摘要**：runtimeLogExplainer 根据 JSONL 生成 summary_with_key_events / stage_summary / events 等粒度，可配置在 run 结束时自动生成。

---

## 五、功能细节

### 5.1 配置体系

- **AgentReviewConfig**（见 types/config.ts）：version、rules（enabled、strict_mode、builtin_rules_enabled、diff_only、code_quality、naming_convention…）、ai_review（enabled、api_*、action、batching_mode、ast_snippet_budget…）、ast、git_hooks、exclusions、runtime_log。
- **规则 action**：每条规则可设 `block_commit` | `warning` | `log`，分别对应 error/warning/info 与是否阻止提交。
- **exclusions**：files（glob）、directories（目录或 glob），FileScanner.shouldExclude / hookRunner 中过滤。

### 5.2 规则引擎（RuleEngine）

- **内置规则**（需 builtin_rules_enabled 且 rules.enabled）：  
  - **no_space_in_filename**：文件名含空格即报，action 来自 naming_convention；  
  - **no_todo**：匹配 TODO/FIXME/XXX（可配置 no_todo_pattern），有 fileDiff 时只查变更行。
- 大文件（默认 >10MB）、二进制（前 8KB 含 0x00）跳过并记一条 warning。
- 输出 ReviewIssue[]，带 file、line、column、message、rule、severity。

### 5.3 AI 审查（AIReviewer）

- **输入**：文件列表 + 可选 diffByFile + 可选 astSnippetsByFile。
- **模式**：  
  - **file_count**：按文件数分批；  
  - **ast_snippet**：按 AST 片段数分批（ast_snippet_budget、ast_chunk_strategy：even/contiguous）。
- **diff_only**：为 true 时只送变更行或 AST 片段，否则送全文件内容。
- **请求**：OpenAI 兼容（或 custom）格式，system_prompt + 每批内容，max_request_chars 超限会二分降载。
- **并发**：batch_concurrency 控制同时请求数；超时与重试由 aiRetryHandler 处理。
- **输出**：zod 校验 choices[].message.content 中的 JSON，解析为 issues 并映射为 ReviewIssue（file、line、column、message、severity）。

### 5.4 AST 片段（astScope）

- 支持 .js/.jsx/.ts/.tsx（Babel）、.vue（SFC 按 block，script 用 Babel，template 仅定位）。
- 根据 FileDiff 的 hunks 确定变更行号，在 AST 上找覆盖这些行的最小节点，截取 startLine/endLine 与 source。
- 受 max_node_lines、max_file_lines 限制，超限或解析失败则回退（不报错，ReviewEngine 可退化为 diff 或全文件）。

### 5.5 Git Hooks

- **安装**：installHooksCommand 或 激活时若 auto_install 且 pre_commit_enabled 且未安装则自动安装。
- **脚本**：GitHookManager.generateHookScript() 生成 Windows 批处理或 Unix shell，设置 WORKSPACE_ROOT 并执行 `node out/hooks/hookRunner.js`。
- **放行**：仅支持永久放行（@ai-ignore 内联注释），由 allowIssueIgnoreCommand 插入，reviewEngine.filterIgnoredIssues 过滤；无“单次提交放行”。

### 5.6 UI

- **ReviewPanel**：TreeView「审查结果」，根节点为状态与统计，子节点按文件分组，再子节点为问题；点击问题跳转编辑器；支持 refresh、放行此条（allowIssueIgnore）、修复等菜单。
- **StatusBar**：显示 idle/reviewing/error 或通过/未通过简要统计。
- **fixIssueCommand**：从 ReviewPanel 当前选中项取 ReviewIssue，可扩展为自动修复（当前主要为占位）。

### 5.7 其他命令

- **agentreview.review**：与 run 类似，由 reviewCommand 注册（入口之一）。
- **agentreview.showReport**：展示当前审查报告（ReviewPanel 已有结果时）。
- **agentreview.installHooks**：显式安装 pre-commit hook。
- **agentreview.allowIssueIgnore**：在问题行上方插入 @ai-ignore 注释，永久放行该条。
- **agentreview.refresh**：刷新审查结果视图。
- **agentreview.runtimeLog.explainLatest**：解释最新运行日志（基于 runtimeLogExplainer）。

---

## 六、关键类型与接口

- **ReviewIssue**：file, line, column, message, reason?, rule, severity, astRange?  
- **ReviewResult**：passed, errors[], warnings[], info[]  
- **FileDiff**：path, hunks[]；**DiffHunk**：newStart, newCount, lines[]  
- **AgentReviewConfig**：见 types/config.ts；RuleConfig：enabled, action, [key]  
- **RuntimeTraceSession**：runId, trigger, startedAt  
- **CommandContext**：reviewEngine, configManager, gitHookManager, reviewPanel, statusBar, logger, getGitRoot  

---

## 七、扩展与测试

- 测试：Vitest，用例在 `src/__tests__/`（config、core、commands、utils、hooks 等），含 mock VSCode 与临时文件。
- 新增规则：在 shared/ruleChecks 加纯函数，在 RuleEngine 中读配置并调用；若需在 hook 中生效，hookRunner 中同样调用 ruleChecks。
- 新增命令：在 extension.ts 中加入 CommandContext 并 registerCommand，在 package.json 的 contributes.commands 中声明。

以上为 AgentReview 的架构、数据流转与功能细节梳理；具体实现以源码为准。
