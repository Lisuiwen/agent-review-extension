## 多根工作区审查策略与 TreeView 方案（当前根默认 + 按根分组）

### 简要摘要
- 目标：把插件从“默认第一个根目录”升级为“多根可用”，并保证审查命令与 TreeView 在多根场景下行为一致。
- 已确认偏好：
  - 手动审查默认范围：`当前根目录`
  - `runStaged` 默认范围：`当前根目录`
  - TreeView 顶层：`按 workspace folder 分组`
- 本次规划不做实现，仅给出可直接落地的实现规格。
- Skills 说明：未使用现有 skills（本任务是架构/交互规划，不是 doc/pdf 处理或代码简化）。

### 现状基线（实现约束）
- 多处逻辑硬编码 `workspaceFolders?.[0]`，影响审查范围、配置加载、日志目录、忽略指纹归属。
- TreeView 当前只维护单份 `ReviewResult`，根节点按“规则/AI”分组，不区分工作区根。
- `FileScanner` 与 `ConfigManager` 构造时绑定首个根目录，不支持按根切换。

---

## 一、审查策略（多根）

### 1.1 统一“当前根”解析规则（新增）
新增 `WorkspaceScopeResolver`（建议文件：`src/workspace/workspaceScopeResolver.ts`）：

- `resolveActiveWorkspaceRoot(): string | null`
- 解析优先级（固定）：
  1. `activeTextEditor.document.uri` 所属根
  2. 最近一次成功审查的根（session 内缓存）
  3. 仅一个 workspace folder 时取该根
  4. 多根且无法判定时弹 `QuickPick`，用户选择后缓存为最近根
- 所有命令入口统一使用此解析器，禁止再次直接读 `workspaceFolders[0]`。

### 1.2 审查命令默认策略
- `agentreview.run`：仅审查“当前根” pending diff。
- `agentreview.runStaged`：仅审查“当前根” staged diff。
- 自动复审（save/idle/manual current file）：
  - 以文件所属根为作用域；
  - 队列与限频按“根+文件”隔离，避免跨根互相挤占。

### 1.3 运行时隔离策略（核心）
新增 `WorkspaceRuntimeRegistry`（建议 `src/workspace/workspaceRuntimeRegistry.ts`）：
- 维护 `Map<workspaceRoot, RootRuntime>`
- `RootRuntime` 包含：
  - `configManager`（按根）
  - `reviewEngine`（按根）
  - 可选根级 logger 前缀（便于排障）
- 生命周期：
  - 激活时为现有 roots 建立 runtime
  - 监听 `onDidChangeWorkspaceFolders` 动态增删 runtime
  - 删除 root 时释放 watcher/disposable

### 1.4 配置与环境变量策略
`ConfigManager` 改为“每根一个实例”：
- 配置文件路径固定为该根下 `.agentreview.yaml`
- `.env` 读取规则：
  - 先读当前根 `.env`
  - 若缺失，按现有 fallback（扩展目录）补
- watcher：每个根独立监听 `.agentreview.yaml` 与 `.env`

### 1.5 Git/diff/忽略指纹/日志的根归属
- `FileScanner` 改为显式传入 `workspaceRoot`（构造参数或方法参数），所有 git 命令在该 root 执行。
- `allowIssueIgnore`：
  - 不再使用 `[0]`，改为 `getWorkspaceFolder(issue.file)` 推导 root；
  - 指纹写入对应根的 `.vscode/agentreview-ignore.json`。
- `runtimeLogPath`：
  - `workspace_docs_logs` 模式下改为“当前审查根”的 `docs/logs`。
- `getGitRoot`：
  - 入参增加 `workspaceRoot`，仅在该根链路内向上查找 `.git`。

---

## 二、TreeView 显示方案（按根分组）

### 2.1 树结构（最终形态）
顶层：
- `<RootNameA> (E/W/I)`（默认展开当前根）
- `<RootNameB> (E/W/I)`（默认折叠）

每个根节点下：
1. 状态节点（reviewing / completed / error + 子状态）
2. 通过/失败摘要节点
3. `规则检测错误 (N)`（默认展开）
4. `AI检测错误 (N)`（默认折叠）

来源节点下：
- 文件节点（显示相对当前根路径）
- 问题节点（保持现有 ignored/stale/severity 图标与跳转能力）

### 2.2 数据模型调整
`ReviewPanelProvider` 从单状态改为多根状态：
- `Map<workspaceRoot, RootReviewState>`
- `RootReviewState`：
  - `result: ReviewResult | null`
  - `status`
  - `statusMessage`
  - `emptyStateHint`
  - `updatedAt`
- `ReviewIssue` 新增可选字段：
  - `workspaceRoot?: string`（写入时即标注，避免每次反推）

### 2.3 ReviewPanel 对外接口调整（公共接口变更）
新增（保留旧接口做兼容包装）：
- `showWorkspaceReviewResult(workspaceRoot, result, status?, statusMessage?, emptyHint?)`
- `setWorkspaceStatus(workspaceRoot, status, statusMessage?)`
- `getWorkspaceResult(workspaceRoot): ReviewResult | null`
- `applyWorkspaceFileReviewPatch(workspaceRoot, params...)`

兼容策略：
- 旧 `showReviewResult(...)` 内部用 `resolveActiveWorkspaceRoot()` 转发到新接口，避免一次性改爆调用方。

---

## 三、命令与交互细节

### 3.1 命令层改造点
- `runReviewCommand.ts`：
  - 解析当前根；
  - 调用 `reviewPendingChangesWithContext({ workspaceRoot })`；
  - 仅更新该根的 panel/status。
- `runStagedReviewCommand.ts`：
  - 同上，改为 `reviewStagedFiles({ workspaceRoot })`。
- `allowIssueIgnoreCommand.ts`：
  - 基于 issue.file 定位 root，避免误写首根。
- `extension.ts`：
  - 注入 `WorkspaceScopeResolver` 与 `WorkspaceRuntimeRegistry`；
  - 自动复审控制器改为按根获取 runtime。

### 3.2 用户可见行为约定
- 多根时首次无活动文件触发命令会弹根选择器；之后本会话复用上次选择。
- TreeView 同时保留各根历史结果，不会被单根复审覆盖。
- 点击问题节点跳转逻辑不变。

---

## 四、测试计划（必须新增）

### 4.1 单元测试
- `workspaceScopeResolver.test.ts`
  - 活动编辑器命中根
  - 无活动编辑器时回退最近根
  - 多根无上下文触发 QuickPick 分支
- `fileScanner.multiroot.test.ts`
  - 同一命令在不同 root 下 cwd 正确
- `configManager.multiroot.test.ts`
  - 每根读取独立 `.agentreview.yaml/.env`
- `reviewPanel.multiroot.test.ts`
  - 顶层按根分组
  - 不同根结果互不覆盖
  - 根内规则/AI分组统计正确
- `allowIssueIgnoreCommand.multiroot.test.ts`
  - 指纹写入正确根 `.vscode/agentreview-ignore.json`

### 4.2 命令集成测试
- `runReviewCommand.multiroot.test.ts`
  - 默认当前根
  - 无可判定根时选择器分支
- `runStagedReviewCommand.multiroot.test.ts`
  - staged 仅针对当前根
- 自动复审相关：
  - A 根编辑不会触发 B 根队列状态变化

### 4.3 回归测试
- 现有单根用例全部通过（行为不退化）：
  - incremental 展示
  - stale/ignore 同步
  - statusBar 展示与文案

---

## 五、实施顺序（建议）
1. 引入 `WorkspaceScopeResolver`（不改业务逻辑，只接入命令入口）
2. 引入 `WorkspaceRuntimeRegistry` + `ConfigManager/FileScanner` 根隔离
3. `ReviewEngine` 新增 `workspaceRoot` 入参链路打通
4. `ReviewPanelProvider` 升级为多根状态树
5. `allowIssueIgnore/runtimeLogPath/getGitRoot` 根归属修正
6. 增补测试并跑全量

---

## 六、公共接口/类型变更清单（明确）
- `ReviewIssue`：新增 `workspaceRoot?: string`
- `ReviewEngine`：
  - `reviewPendingChangesWithContext(options?: { workspaceRoot: string })`
  - `reviewStagedFiles(options?: { workspaceRoot: string })`
- `ReviewPanel`：
  - 新增 `showWorkspaceReviewResult` / `setWorkspaceStatus` / `getWorkspaceResult`
- 新增模块：
  - `WorkspaceScopeResolver`
  - `WorkspaceRuntimeRegistry`

---

## 七、假设与默认值（已锁定）
- 默认作用域：`当前根目录`（run + runStaged）
- TreeView 顶层：`按根分组`
- 无法确定当前根时：弹一次选择器并缓存会话选择
- 旧接口保留一版兼容，避免一次性改动过大
