# 设计：no_pending_diff 时清除该文件在面板中的 issue

## Context

- **现状**：自动复审门控（`src/core/autoReviewGate.ts`）在 `!diff || diff.hunks.length === 0` 时返回 `skip: true, reason: 'no_pending_diff'`。消费者（`src/extension.ts` 约 404–424 行）在 skip 时：若 `reason === 'same_content'` 会调用 `readyReviewPanel.clearFileStaleMarkers(nextPath)`；其他 reason（含 `no_pending_diff`）仅打日志与更新状态，**不**清理面板。
- **数据结构**：复审结果为全局 `ReviewResult`（errors / warnings / info 数组，每项带 `issue.file`）。面板通过 `ReviewPanelProvider` 持有当前 result，有 `clearFileStaleMarkers(filePath)`（仅把该文件下 issue 的 `stale` 置为 false），无「按文件移除 issue」的接口。
- **约束**：按文件粒度清理，不清空整个 result；与 same_content 的「仅该文件」语义一致。TypeScript + Vitest，UTF-8，中文产物。

## Goals / Non-Goals

**Goals:**

- 当门控因 `no_pending_diff` 跳过某文件时，清除该文件在复审面板中的**全部 issue**（从 result 中移除该文件对应的 errors/warnings/info，并刷新面板）。
- 在 ReviewPanel 上提供「按文件清除 issue」的能力（如 `clearIssuesForFile(filePath)`），供 extension 在 `no_pending_diff` 分支调用。
- 保持门控逻辑不变；其他 skip reason 行为不变。

**Non-Goals:**

- 不改变 `no_pending_diff` 的判定条件，不新增或修改门控配置。
- 不为其他 skip reason（如 small_low_risk_change、diagnostic_funnel）增加清理逻辑（本 change 仅 no_pending_diff）。
- 不改变 same_content 现有行为（仍使用 clearFileStaleMarkers，不强制改为 clearIssuesForFile）。

## Decisions

1. **新增 `clearIssuesForFile(filePath: string)`**
   - **理由**：面板当前只有按文件清除 stale 标记的能力，没有按文件移除 issue 的能力；no_pending_diff 语义是「该文件已无待审变更」，应移除该文件在面板中的全部 issue，与「仅清 stale」不同。
   - **实现要点**：从 `provider.getCurrentResult()` 取当前 result；用 `getAllIssuesFromResult` 取全部 issue，过滤掉 `path.normalize(issue.file) === path.normalize(filePath)` 的项；用 `buildResultFromIssues` 重组为 `ReviewResult`，再 `normalizeResultForDisplay`（与现有展示逻辑一致）；`provider.updateResult(nextResult, status)` 并 `syncTreeViewBadgeAndDescription()`。若 currentResult 为空或过滤后无变化则直接 return。
   - **备选**：在 extension 里直接操作 result 再 set——不利于封装，且 result 的组装/去重逻辑在 panel 侧，故采用在 ReviewPanel 上新增方法。

2. **extension 中在 `no_pending_diff` 分支调用 `clearIssuesForFile`**
   - **理由**：与 same_content 分支调用 `clearFileStaleMarkers` 对称；仅在该文件被跳过时清理该文件，符合「按文件粒度」。
   - **位置**：在 `if (gateDecision.reason === 'same_content') { readyReviewPanel.clearFileStaleMarkers(nextPath); ... } else { ... }` 中，在 `else` 内增加 `if (gateDecision.reason === 'no_pending_diff') { readyReviewPanel.clearIssuesForFile(nextPath); }`，然后保持原有日志与 updateCompletedStatus / logAutoReviewSkipped。

3. **不统一 same_content 与 no_pending_diff 为同一清理方法**
   - **理由**：same_content 表示「内容与上次复审一致」，只需清除 stale 标记；no_pending_diff 表示「无待审 diff」，应移除该文件所有 issue。语义不同，保留两个入口更清晰；若未来产品上希望 same_content 也移除 issue，可再在 same_content 分支增加对 clearIssuesForFile 的调用。

## Risks / Trade-offs

- **[Risk]** clearIssuesForFile 后该文件在树视图中消失，若用户正在看该文件节点可能略突兀。  
  **Mitigation**：与 same_content 的 clearFileStaleMarkers 类似，均为「该文件不再有待审/陈旧内容」的合理反馈；产品上可接受。

- **[Risk]** 并发或多次快速触发 no_pending_diff 时多次调用 clearIssuesForFile。  
  **Mitigation**：实现为幂等（无该文件 issue 时 early return），无额外副作用。

## Migration Plan

- 无数据迁移。按序发布：先合入 ReviewPanel.clearIssuesForFile 与 extension 调用，再发版即可。

## Open Questions

- 无。

## 测试与验证

- **覆盖策略**：针对「no_pending_diff 时清除该文件 issue」做扩展层集成测试（门控消费者调用 panel.clearIssuesForFile）；面板层 `clearIssuesForFile` 的单元测试可选，若逻辑简单可仅靠集成测试覆盖。
- **已有覆盖**：`src/__tests__/core/autoReviewGate.test.ts` 已有「无 pending diff 时应跳过 no_pending_diff」；`src/__tests__/extension/autoReviewController.test.ts` 已有 same_content 时 `clearFileStaleMarkers` 被调用的用例（如 1.5、2.4、2.5）。当前**无** no_pending_diff 时清理面板的测试。
- **TDD**：本逻辑为「在现有分支增加一次方法调用 + 面板新方法」，采用先实现再补测即可，不强制 TDD。

| 测什么 | 条件 | 期望 | 断言要点 |
|--------|------|------|----------|
| no_pending_diff 时 extension 调用面板「按文件清除 issue」 | 门控返回 skip、reason 为 no_pending_diff，且 nextPath 已知 | 消费者调用 readyReviewPanel.clearIssuesForFile(nextPath) | 在 autoReviewController 测试中 mock ReviewPanel，门控 mock 返回 no_pending_diff，expect clearIssuesForFile 以该 path 被调用一次 |
| clearIssuesForFile 从 result 中移除指定文件全部 issue | 当前 result 含 A、B 两文件的 issue；调用 clearIssuesForFile(A) | result 中仅剩 B 的 issue；树/徽标刷新 | 若写 panel 单测：getCurrentResult() 中该文件无任何 issue；errors/warnings/info 长度与预期一致 |

- **目标文件**：`src/__tests__/extension/autoReviewController.test.ts`（新增或扩展现有 describe）；可选 `src/__tests__/ui/reviewPanel.test.ts` 或等价面板单测（若存在）。
- **特殊说明**：controller 测试需 mock evaluateSaveTaskGate 返回 `{ skip: true, reason: 'no_pending_diff', ... }`，并注入对 ReviewPanel 的 mock，断言其 `clearIssuesForFile` 被以正确路径调用。

## 实现难度与风险评估

- **实现难度**：低。ReviewPanel 新增约十余行；extension 分支增加约 2 行调用。测试为在现有 controller 测试中增加一个用例并 mock。
- **风险评估**：低。改动局部、无新依赖、行为与 same_content 对称，易回滚。
