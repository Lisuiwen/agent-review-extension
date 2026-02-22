## 1. 测试（TDD：先写失败用例）

- [x] 1.1 在 `autoReviewController.test.ts` 中新增：manual 任务完成时用 `reviewedContentHash` 更新 `lastReviewedContentHash` 的用例（先写失败断言，再在后续实现后通过）
- [x] 1.2 在 `autoReviewController.test.ts` 中新增：idle 任务完成时用 `reviewedContentHash` 更新 `lastReviewedContentHash` 的用例
- [x] 1.3 在 `autoReviewController.test.ts` 中新增：save 任务完成时仅用 `savedContentHash` 更新、不受 `reviewedContentHash` 影响的用例
- [x] 1.4 在 `autoReviewController.test.ts` 中新增：手动入队时任务带有 `reviewedContentHash`（等于当前文档内容哈希）的用例
- [x] 1.5 在 `autoReviewController.test.ts` 中新增（可选）：撤销回已评审内容后 `clearFileStaleMarkers` 被调用的用例

## 2. 任务类型与入队

- [x] 2.1 在 `extension.ts` 中为 `QueuedAutoReviewTask` 增加可选字段 `reviewedContentHash: string | null`
- [x] 2.2 在 `reviewCurrentFileNow` 入队前用 `createContentHash(editor.document.getText())` 计算哈希，入队时传入 `reviewedContentHash`
- [x] 2.3 在 `scheduleIdleReview` 入队前取当前 editor 的 `document.getText()` 计算哈希，入队时传入 `reviewedContentHash`（无 editor 则传 null）

## 3. 应用结果分支

- [x] 3.1 在「应用结果」分支内，在 `task.trigger === 'save' && task.savedContentHash` 之后增加 `else if ((task.trigger === 'manual' || task.trigger === 'idle') && task.reviewedContentHash)`，执行 `latestState.lastReviewedContentHash = task.reviewedContentHash`

## 4. 验收与收尾

- [x] 4.1 运行 `autoReviewController.test.ts` 全部用例通过，确认新增用例已覆盖 design 中「测试与验证」的断言要点
- [x] 4.2 在 design.md 的「已有覆盖」中补充本次新增用例对应关系（可选）
