## 1. 多根根解析与归属模型

- [x] 1.1 扩展 `src/utils/workspaceRoot.ts`：新增多根枚举与按文件定位能力（保留 `getEffectiveWorkspaceRoot()` 兼容入口）。
- [x] 1.2 扩展 `src/types/review.ts`：为 `ReviewIssue` 增加可选 `workspaceRoot` 归属字段，并同步更新相关类型引用。
- [x] 1.3 改造 `src/utils/fileScanner.ts`：将 Git/diff 相关方法改为显式接收 `workspaceRoot`，移除构造时单根固化依赖。

## 2. 聚合执行与忽略隔离（按 TDD）

- [x] 2.1 先写失败测试：多根仅 Git 项目参与调度（建议新增 `src/__tests__/core/multiRootCoordinator.test.ts`）。
- [x] 2.2 先写失败测试：多项目任务共享全局并发池，峰值并发不超过配置上限（`src/__tests__/core/multiRootCoordinator.test.ts`）。
- [x] 2.3 先写失败测试：聚合结果中每条 issue 都注入正确 `workspaceRoot`（`src/__tests__/core/reviewEngine*.test.ts`）。
- [x] 2.4 实现多根聚合调度层（coordinator）并接入 `ReviewEngine` 审查入口，支持全局并发与结果汇总。
- [x] 2.5 先写失败测试：相同指纹跨项目 ignore 隔离（A 项目 ignore 不影响 B 项目）（`src/__tests__/core/reviewEngine*.test.ts`、`src/__tests__/commands/ignoreIssueCommand.test.ts`）。
- [x] 2.6 实现按 `workspaceRoot` 读写 ignore store（`<workspaceRoot>/.vscode/agentreview-ignore.json`）并完成过滤链路改造。

## 3. 命令入口接线与回归（按 TDD）

- [x] 3.1 先写失败测试：`agentreview.run` 在多根下聚合执行并正确汇总结果（`src/__tests__/commands/runReviewCommand.test.ts`）。
- [x] 3.2 先写失败测试：`agentreview.runStaged` 在多根下聚合执行并正确汇总结果（`src/__tests__/commands/runStagedReviewCommand.test.ts`）。
- [x] 3.3 改造 `run/runStaged/save` 入口接入多根聚合调度（本阶段仅数据归属与汇总，不改 TreeView 分树）。
- [x] 3.4 执行单根回归测试并修复兼容问题（覆盖 config/scanner/reviewEngine/commands/autoReview 关键路径）。

## 4. 验证与收尾

- [x] 4.1 运行并记录本变更相关测试结果（新增多根测试 + 既有单根回归测试）。
- [x] 4.2 更新变更文档中的 Open Questions 结论（run summary 聚合策略、AI file 为空时归属策略）。
- [x] 4.3 自检并确认 `openspec status --change multi-root-data-attribution` 达到 artifact 全部完成状态。


