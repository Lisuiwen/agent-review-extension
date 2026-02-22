## Why

当前 `agentreview.run` 与 `agentreview.runStaged` 审查成功后未同步更新 `lastReviewedContentHash`，导致用户在「已审 -> 编辑成待复审 -> 撤销未保存改动」的常见路径上，待复审标记无法按预期清理。该行为与保存触发的自动复审不一致，直接破坏撤销体验与状态可信度。

## What Changes

- 在 `agentreview.run` 审查结果成功落地后，写入本次实际审查内容对应的 `lastReviewedContentHash`。
- 在 `agentreview.runStaged` 审查结果成功落地后，按同一规则写入 `lastReviewedContentHash`。
- 对齐与现有 auto-review 的过期/异常处理语义：仅在结果被应用时写 hash，过期结果与失败路径不写入。
- 保持 `onDidChangeTextDocument` 的 stale 清理逻辑不变，继续依赖 `currentHash === lastReviewedContentHash` 触发 `clearFileStaleMarkers`。

## Capabilities

### New Capabilities
- `run-staged-hash-consistency`: 统一 run/runStaged 与 auto-review 的已审内容哈希持久化语义，保证撤销未保存改动时待复审标记可正确清理。

### Modified Capabilities
- 无。

## Impact

- **受影响代码**：`src/extension.ts`（`agentreview.run`、`agentreview.runStaged` 成功路径 hash 写入）、可能涉及共享状态写入辅助逻辑。
- **测试**：`src/__tests__/extension/autoReviewController.test.ts` 或同层命令入口测试需新增 run/runStaged 成功与撤销清理场景。
- **用户可见行为**：待复审标记清理时机更一致；无新增配置项、无破坏性变更。
