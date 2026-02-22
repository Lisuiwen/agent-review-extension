# manual-review-store-hash

手动/空闲评审完成后持久化「已评审内容」哈希，使文档撤销回已评审内容时能清除陈旧标记。

## Requirements

### Requirement: 手动与空闲评审完成后持久化已评审内容哈希

当触发方式为 `manual` 或 `idle` 的自动复审任务执行完成并应用结果时，系统 SHALL 将「入队时记录的、将要评审的文档内容」对应的哈希写入该文件对应的 `lastReviewedContentHash` 状态。保存触发的任务 SHALL 继续仅使用 `task.savedContentHash` 更新 `lastReviewedContentHash`，不得改为使用本哈希。

#### Scenario: 手动评审完成后写入 reviewedContentHash

- **WHEN** 用户执行「立即复审当前文件」，任务以 `trigger: 'manual'` 入队且入队时记录了当前文档内容的 `reviewedContentHash`
- **AND** 该任务执行完成且结果被应用（未因过期丢弃）
- **THEN** 该文件对应的 `lastReviewedContentHash` 被设置为该任务的 `reviewedContentHash`

#### Scenario: 空闲评审完成后写入 reviewedContentHash

- **WHEN** 空闲触发的复审任务以 `trigger: 'idle'` 入队且入队时记录了当前文档内容的 `reviewedContentHash`
- **AND** 该任务执行完成且结果被应用（未因过期丢弃）
- **THEN** 该文件对应的 `lastReviewedContentHash` 被设置为该任务的 `reviewedContentHash`

#### Scenario: 保存触发仍仅使用 savedContentHash

- **WHEN** 保存触发的复审任务（`trigger: 'save'`）执行完成且结果被应用
- **THEN** `lastReviewedContentHash` 仅从 `task.savedContentHash` 更新，不使用 `reviewedContentHash`

#### Scenario: 撤销回已评审内容后清除陈旧标记

- **WHEN** 某文件曾因手动或空闲评审完成而将 `lastReviewedContentHash` 设为当时评审内容的哈希
- **AND** 用户随后编辑文档再通过撤销恢复为与当时评审内容一致
- **THEN** `onDidChangeTextDocument` 中现有逻辑（`currentHash === lastReviewedContentHash` 时调用 `clearFileStaleMarkers`）会清除该文件的待评审标记

### Requirement: 入队时记录将要评审内容的哈希

对于 `trigger` 为 `manual` 或 `idle` 的入队任务，系统 SHALL 在入队时根据当前文档内容计算哈希并写入任务的 `reviewedContentHash` 字段，供完成后持久化使用。`trigger` 为 `save` 的任务可不为 `reviewedContentHash` 赋值（或与 `savedContentHash` 一致，由实现决定），且完成时仅使用 `savedContentHash` 更新状态。

#### Scenario: 手动入队时带有 reviewedContentHash

- **WHEN** 用户触发「立即复审当前文件」，且当前文档已保存
- **THEN** 入队任务的 `reviewedContentHash` 为当前文档内容的哈希（与 `createContentHash(document.getText())` 一致）

#### Scenario: 空闲入队时带有 reviewedContentHash

- **WHEN** 空闲定时器触发且决定对某文件入队 `idle` 任务
- **THEN** 入队任务的 `reviewedContentHash` 为当时该文件文档内容的哈希
