## 1. 入口与状态写入实现

- [x] 1.1 在 `src/extension.ts` 中定位 `agentreview.run` 成功应用结果分支，补充 `lastReviewedContentHash` 写入（仅结果被应用时写入）。
- [x] 1.2 在 `src/extension.ts` 中定位 `agentreview.runStaged` 成功应用结果分支，按与 run 一致的语义补充 `lastReviewedContentHash` 写入。
- [x] 1.3 统一 run/runStaged 的 hash 来源，确保与各自审查输入内容一致（避免写入与实际审查内容不一致）。
- [x] 1.4 明确失败、取消、过期或异常路径不更新 `lastReviewedContentHash`，避免污染已审状态。

## 2. 测试（按 TDD 先测后实现）

- [x] 2.1 先新增失败用例：`agentreview.run` 成功应用结果后会更新 `lastReviewedContentHash`。
- [x] 2.2 先新增失败用例：`agentreview.runStaged` 成功应用结果后会更新 `lastReviewedContentHash`。
- [x] 2.3 先新增失败用例：run/runStaged 结果未应用（失败/过期）时不更新 `lastReviewedContentHash`。
- [x] 2.4 新增失败用例：run 路径下编辑后撤销未保存改动可触发 `clearFileStaleMarkers`。
- [x] 2.5 新增失败用例：runStaged 路径下编辑后撤销未保存改动可触发 `clearFileStaleMarkers`。
- [x] 2.6 完成实现后运行并修复上述测试，确认全部通过。

## 3. 回归与收尾

- [x] 3.1 回归执行与手动审查状态相关的既有测试，确认不影响 auto-review/save 路径行为。
- [x] 3.2 自检 `onDidChangeTextDocument` 现有 stale 清理逻辑未被改动，仅依赖新增一致性写入生效。
- [x] 3.3 更新本 change 的勾选状态与必要说明，确保可直接进入 `/opsx:apply` 实现阶段。
