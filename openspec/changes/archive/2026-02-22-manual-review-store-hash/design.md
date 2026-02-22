## Context

- **现状**：`extension.ts` 中 `registerAutoReviewOnSave` 管理三种触发方式（save / idle / manual）。仅保存触发的任务在入队时带有 `savedContentHash`，完成时用其更新 `lastReviewedContentHash`；手动与空闲任务当前入队时 `savedContentHash: null`，完成时也未更新 `lastReviewedContentHash`。`onDidChangeTextDocument` 中已有逻辑：当 `currentHash === state.lastReviewedContentHash` 时调用 `reviewPanel.clearFileStaleMarkers(filePath)`，故只有「保存路径」能享受撤销后清除陈旧的效果。
- **约束**：保存路径语义不变，仅从 `task.savedContentHash` 写 `lastReviewedContentHash`；手动/空闲路径单独用入队时记录的「已评审内容」哈希写入，二者互不混用。

## Goals / Non-Goals

**Goals:**

- 手动与空闲评审完成后，将「入队时记录的文档内容」对应的哈希持久化到 `lastReviewedContentHash`，使撤销回该内容时能清除待评审标记。
- 入队时为 manual/idle 任务计算并保存 `reviewedContentHash`（入队时刻的文档内容哈希）。

**Non-Goals:**

- 不改变保存触发时的写入来源（仍仅 `savedContentHash`）。
- 不新增配置项或 UI。

## Decisions

1. **任务类型扩展**：在 `QueuedAutoReviewTask` 中新增可选字段 `reviewedContentHash: string | null`。保存任务可不设或与 `savedContentHash` 一致；manual/idle 入队时用当前文档 `createContentHash(getText())` 写入，完成后仅在此分支用该值更新 `lastReviewedContentHash`。
2. **写入时机**：在现有「应用结果」分支内，在 `task.trigger === 'save' && task.savedContentHash` 之后增加 `else if ((task.trigger === 'manual' || task.trigger === 'idle') && task.reviewedContentHash)` 分支，执行 `latestState.lastReviewedContentHash = task.reviewedContentHash`。
3. **入队处**：`scheduleIdleReview` 在入队前取当前 editor 的 `document.getText()` 计算哈希并传入任务；`reviewCurrentFileNow` 在入队前取 `editor.document.getText()` 计算哈希并传入任务。若无法取得内容（如无 editor），则 `reviewedContentHash` 为 null，完成后不更新 `lastReviewedContentHash`（与当前行为一致）。

## Risks / Trade-offs

- **[Risk]** 入队与执行完成之间文档被保存，内容可能已变：当前已有 stale 判定（editRevision/saveRevision/requestSeq），过期结果会被丢弃，不应用也不会写哈希；若结果被应用，则写入的是「入队时」的内容哈希，与本次实际评审内容一致，行为正确。
- **[Trade-off]** manual/idle 不写 `savedContentHash`、仅写 `reviewedContentHash`，避免与「仅保存路径写 lastReviewedContentHash」的语义混淆，便于后续若需区分「上次保存评审」与「上次任意评审」时扩展。

## 测试与验证

- **涉及 spec**：`specs/manual-review-store-hash/spec.md`（Requirement：入队时记录哈希、手动/空闲完成后持久化、保存路径不变、撤销后清除陈旧）。
- **覆盖策略**：在 `src/__tests__/extension/autoReviewController.test.ts` 中新增或扩展用例，覆盖入队携带 `reviewedContentHash`、应用结果时 manual/idle 分支写入 `lastReviewedContentHash`、保存分支仍仅用 `savedContentHash`；可选：通过 `onDidChangeTextDocument` 模拟内容恢复后断言 `clearFileStaleMarkers` 被调用。
- **TDD**：本变更逻辑清晰、与现有控制器测试风格一致，可采用先写失败用例再实现（TDD）完成扩展与分支逻辑。

| 测什么 | 条件 | 期望 | 断言要点 |
|--------|------|------|----------|
| manual 任务完成时用 reviewedContentHash 更新 lastReviewedContentHash | 入队任务 trigger=manual、带 reviewedContentHash；执行完成且未过期 | ensureState(path).lastReviewedContentHash === task.reviewedContentHash | 在 apply 分支后读取 state，expect(lastReviewedContentHash).toBe(reviewedContentHash) |
| idle 任务完成时用 reviewedContentHash 更新 lastReviewedContentHash | 入队任务 trigger=idle、带 reviewedContentHash；执行完成且未过期 | ensureState(path).lastReviewedContentHash === task.reviewedContentHash | 同上 |
| save 任务完成时仅用 savedContentHash 更新 | 入队任务 trigger=save、savedContentHash 有值 | lastReviewedContentHash 被设为 task.savedContentHash，不受 reviewedContentHash 影响 | 传入仅 savedContentHash 的 task，expect(state.lastReviewedContentHash).toBe(task.savedContentHash) |
| 手动入队时任务带有 reviewedContentHash | 调用 reviewCurrentFileNow，当前文档内容已知 | 入队任务的 reviewedContentHash 等于 createContentHash(当前文档内容) | 通过 mock 或注入捕获 enqueue 的 task，expect(task.reviewedContentHash).toBe(expectedHash) |
| 撤销回已评审内容后清除陈旧标记 | lastReviewedContentHash 已设；触发 onDidChangeTextDocument 且 getText() 返回的内容哈希等于 lastReviewedContentHash | clearFileStaleMarkers(filePath) 被调用 | 设置 state.lastReviewedContentHash，触发 change 且 mock getText 返回对应内容，expect(clearFileStaleMarkers).toHaveBeenCalledWith(filePath) |

**已有覆盖**：现有测试已有 save 路径与 clearFileStaleMarkers 的用例；本次新增上述 manual/idle 写入与入队 reviewedContentHash、以及（可选）撤销清除的断言。

本次新增用例与「测试与验证」表格对应关系：
- 1.1 → manual 任务完成时用 reviewedContentHash 更新 lastReviewedContentHash（通过 manual 完成后触发 document change 同内容断言 clearFileStaleMarkers 间接验证）
- 1.2 → idle 任务完成时用 reviewedContentHash 更新 lastReviewedContentHash（同上）
- 1.3 → save 任务完成时仅用 savedContentHash 更新（save 完成后触发 document change 同内容断言 clearFileStaleMarkers）
- 1.4 → 手动入队时任务带有 reviewedContentHash（通过 context.__agentReviewCaptureEnqueue 注入捕获入队 task，断言 task.reviewedContentHash === createContentHash(当前文档内容)）
- 1.5 → 撤销回已评审内容后 clearFileStaleMarkers 被调用（与 1.1 同一断言路径；另保留 save 路径的「内容 hash 回滚到 lastReviewed」用例）

## Migration Plan

- 无数据迁移。代码变更仅限 extension.ts 与测试文件，部署后即生效。

## Open Questions

- 无。

## 实现难度与风险评估

- **实现难度**：低。改动点集中（任务类型、三处入队、一处应用分支），且不改变现有保存路径逻辑。
- **风险评估**：低。仅增加字段与分支，过期判定与现有逻辑复用；测试覆盖入队与应用分支即可降险。
