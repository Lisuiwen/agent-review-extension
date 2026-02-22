## Why

当前仅「保存触发」的自动评审会更新 `lastReviewedContentHash`；手动触发（以及可选的空闲触发）评审完成后不会持久化该哈希。因此当用户通过撤销将文档恢复为之前已评审过的内容时，现有的「当前哈希 === 上次评审哈希 → 清除文件陈旧标记」逻辑无法生效，「待评审」（陈旧）状态不会被清除。

## What Changes

- 在任务入队时记录「将要评审的内容」的哈希（例如任务字段 `reviewedContentHash`，在入队时根据当前文档内容计算）。
- 手动评审（以及可选的空闲评审）完成并应用结果时，用该任务的 `reviewedContentHash` 持久化到 `lastReviewedContentHash`（或等价存储），使 `onDidChangeTextDocument` 中已有逻辑在撤销回已评审内容后也能清除陈旧标记。
- 保存路径保持不变：仅保存触发的评审继续从 `task.savedContentHash` 写入；手动/空闲触发的评审从 `task.reviewedContentHash` 写入，二者互不覆盖对方语义。

## Capabilities

### New Capabilities

- `manual-review-store-hash`：手动/空闲评审完成后持久化「已评审内容」哈希，使撤销回已评审内容时能清除陈旧标记（规格见 specs/manual-review-store-hash/spec.md）。

### Modified Capabilities

（仓库中暂无独立的 auto-review 规格；行为变更见上文 What Changes，具体需求在 specs 中以增量规格描述。）

## Impact

- **extension.ts**：`registerAutoReviewOnSave` 及相关逻辑——任务类型/入队处为手动与空闲评审写入 `reviewedContentHash`；应用结果分支中，手动/空闲完成时从 `task.reviewedContentHash` 持久化，保存路径仍仅使用 `task.savedContentHash`。
- **测试**：`src/__tests__/extension/autoReviewController.test.ts` 需覆盖手动/空闲评审完成后持久化哈希及撤销后清除陈旧标记的场景。
