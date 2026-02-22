# 工作区根解析兼容性重构 - 任务

## 1. 统一入口与测试

- [x] 1.1 在 extension 或公共 util 中实现 `getEffectiveWorkspaceRoot(): vscode.WorkspaceFolder | undefined`（无 folder 返回 undefined，否则返回 `workspaceFolders[0]`）
- [x] 1.2 （可选）新增 `src/__tests__/utils/workspaceRoot.test.ts`，覆盖无 folder / 单 folder / 多 folder 时解析结果与 design 一致
- [x] 1.3 运行现有单根相关单测，确认作为回归基线可全部通过（重构前基线）

## 2. 配置与扫描

- [x] 2.1 ConfigManager：构造或首次需要根时改为调用 `getEffectiveWorkspaceRoot()`，用其计算 configPath/envPath 与 watcher
- [x] 2.2 FileScanner：构造时或使用根处改为调用统一入口（或接收上层传入的 root），不再直接使用 `workspaceFolders?.[0]`
- [x] 2.3 configWatcher：接收的 workspaceFolder 由调用方通过统一入口传入，调用方改为传 `getEffectiveWorkspaceRoot()`

## 3. 审查与运行摘要

- [x] 3.1 ReviewEngine：内部所有取 `workspaceFolders?.[0]` 处改为在单点调用统一入口或由调用方传入 workspaceRoot，并向下传递
- [x] 3.2 reviewEngine.runSummary（getProjectName 等）：使用由调用方传入的 workspaceRoot，或内部单点调用统一入口
- [x] 3.3 extension.ts：getGitRoot、保存门控等需要根的地方改为使用 `getEffectiveWorkspaceRoot()`

## 4. 命令与其它

- [x] 4.1 ignoreIssueCommand：取根处改为调用 `getEffectiveWorkspaceRoot()`
- [x] 4.2 runtimeLogPath.resolveRuntimeLogBaseDir：取根处改为调用统一入口
- [x] 4.3 全文 grep `workspaceFolders?.[0]` 及变体，确认除测试/mock 外无遗漏

## 5. 回归验证

- [x] 5.1 运行完整单测（含 configManager、fileScanner、reviewEngine、ignoreIssue、runtimeLogPath、autoReviewController、runReview、runStaged 等），确认全部通过
- [x] 5.2 若有集成/扩展测试，一并运行并确认单根行为无回归
