# 提案：no_pending_diff 时清除该文件在复审面板中的 issue 列表

## Why

当自动复审门控因「无待审查变更」返回 `no_pending_diff`（例如用户撤销编辑或 git revert 导致该文件没有 pending diff）时，扩展目前仅跳过复审并打日志，**不会**清除该文件在复审面板中的 issue 列表。与之对比，`same_content` 已会调用 `clearFileStaleMarkers` 清理该文件的陈旧标记。行为不一致会导致：用户撤销改动后，面板仍显示该文件的历史 issue，造成困惑。因此需要在 `no_pending_diff` 时对该文件做与 `same_content` 类似的「仅该文件」的清理（按文件粒度，而非清空整个 result）。

## What Changes

- 在门控消费者（extension 中处理 gate 跳过逻辑处）：当 `gateDecision.reason === 'no_pending_diff'` 时，除现有日志与状态更新外，**清除该文件在复审面板中的 issue 列表**（仅该文件，不清空全局 result）。
- 复审面板：若当前仅有 `clearFileStaleMarkers` 而无「按文件清除 issue」能力，则**新增**按文件清除 issue 的接口（例如 `clearIssuesForFile(filePath)`），并在 `no_pending_diff` 与现有 `same_content` 路径中按需调用。
- 不改变门控本身对 `no_pending_diff` 的判定条件（`!diff || diff.hunks.length === 0`），不改变其他 skip reason 的现有行为。

## Capabilities

### New Capabilities

- `clear-file-issues-on-skip`：当自动复审因某文件被跳过（本 change 聚焦 `no_pending_diff`）时，清除该文件在复审面板中的 issue 列表，保持与 `same_content` 一致的按文件粒度清理行为。

### Modified Capabilities

- 无（现有 openspec/specs 未覆盖「门控跳过时面板按文件清理」的需求规格，故不修改既有 capability）。

## Impact

- **受影响代码**：`src/extension.ts`（门控消费者，约 404–424 行）、`src/ui/reviewPanel.ts`（若需新增 `clearIssuesForFile` 或等价能力）。
- **API**：ReviewPanel 可能新增 `clearIssuesForFile(filePath: string)` 或等价方法；内部需从全局 result（errors/warnings/info 等按 `issue.file` 区分）中移除该文件对应项并刷新面板。
- **依赖与系统**：无新增依赖；与现有 autoReviewGate、reviewPanel、result 数据结构兼容。
- **测试**：需在 design 的「测试与验证」中补充 no_pending_diff 时该文件 issue 被清除的用例，tasks 中对应测试任务。
