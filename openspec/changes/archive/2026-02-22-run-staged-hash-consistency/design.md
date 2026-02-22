## Context

- 已确认问题：文件存在已审条目后，用户编辑触发待复审，再撤销未保存改动时，待复审标记不会消失。
- 根因：`src/extension.ts` 中 `lastReviewedContentHash` 仅在 auto-review（save/manual/idle 任务成功分支）写入；`agentreview.run` 与 `agentreview.runStaged` 的成功路径未写入。
- 现有 stale 清理依赖 `onDidChangeTextDocument` 中 `currentHash === lastReviewedContentHash`，因此 run/runStaged 入口形成的已审状态无法在撤销路径命中清理条件。
- 目标是补齐入口一致性，不改动 stale 判定规则本身，不新增 UI 或配置项。

## Goals / Non-Goals

**Goals:**

- 在 `agentreview.run` 成功应用审查结果后，持久化本次已审内容对应 hash 到 `lastReviewedContentHash`。
- 在 `agentreview.runStaged` 成功应用审查结果后，按同一规则持久化 hash。
- 与 auto-review 现有语义保持一致：仅成功应用结果时写入；失败、过期、被取消结果不写入。
- 让 run/runStaged 路径下的“撤销未保存改动”能够通过现有 `currentHash === lastReviewedContentHash` 清理待复审标记。

**Non-Goals:**

- 不改变 `onDidChangeTextDocument` 的 stale 清理逻辑与触发条件。
- 不改动 auto-review 的 save/manual/idle 既有行为。
- 不引入新的状态字段、配置开关或 UI 呈现。

## Decisions

1. **写入位置统一在“结果被应用”之后**  
   - 在 `agentreview.run` 与 `agentreview.runStaged` 的成功路径中，仅在确认结果被接受并完成状态更新后写入 `lastReviewedContentHash`。  
   - 这样与 auto-review 的“仅应用成功写入”一致，避免失败结果污染状态。

2. **写入值使用“本次实际被审内容 hash”**  
   - run 入口使用本次审查请求对应文档内容的 hash；runStaged 入口使用本次 staged 上下文对应内容的 hash。  
   - 不复用与该入口语义不匹配的字段，避免把“保存时 hash”误用于非保存入口。

3. **过期/异常路径明确不写入**  
   - 若出现结果过期（例如请求序号落后）、应用阶段失败、用户取消或引擎异常，保持 `lastReviewedContentHash` 不变。  
   - 该策略保证“已审 hash”只代表真实生效的最近一次审查结果。

4. **保持 stale 清理逻辑零改动**  
   - 继续依赖现有 `currentHash === lastReviewedContentHash` 触发 `clearFileStaleMarkers(filePath)`。  
   - 本次只补齐写入来源，不新增第二套清理判定，降低回归面。

## Risks / Trade-offs

- **[Risk] runStaged 的输入内容来源与实际应用内容不一致**  
  **Mitigation**：实现时明确“计算 hash 的内容来源与审查输入一致”，并在测试中验证写入值与该来源一致。

- **[Risk] 写入时机提前，导致失败结果也覆盖 hash**  
  **Mitigation**：统一在结果确认应用后写入；增加失败/过期不写入测试。

- **[Trade-off] 继续沿用单一 `lastReviewedContentHash`**  
  当前不区分“保存审查 hash / 手动审查 hash / staged 审查 hash”来源，优点是改动小、与现有清理逻辑兼容；若后续需溯源可再扩展。

## 测试与验证

- **涉及 spec**：`openspec/changes/run-staged-hash-consistency/specs/run-staged-hash-consistency/spec.md`
- **覆盖策略**：优先扩展 `src/__tests__/extension/autoReviewController.test.ts` 或现有 run/runStaged 命令测试，验证 run、runStaged 的写入与撤销清理行为。
- **TDD 建议**：适合采用 TDD，先写 run/runStaged 失败用例，再补实现使其通过。

| 测什么 | 条件 | 期望 | 断言要点 |
|--------|------|------|----------|
| run 成功后写入 lastReviewedContentHash | 触发 `agentreview.run`，结果成功并被应用 | `lastReviewedContentHash` 更新为本次 run 输入内容 hash | 完成后读取状态，`expect(lastReviewedContentHash).toBe(expectedHash)` |
| runStaged 成功后写入 lastReviewedContentHash | 触发 `agentreview.runStaged`，结果成功并被应用 | `lastReviewedContentHash` 更新为本次 staged 输入内容 hash | 完成后读取状态，`expect(lastReviewedContentHash).toBe(expectedHash)` |
| run/runStaged 失败或过期不写入 | 触发 run 或 runStaged，但结果失败/过期/未应用 | `lastReviewedContentHash` 保持原值 | 执行前后对比，`expect(afterHash).toBe(beforeHash)` |
| run 入口下撤销未保存改动可清理待复审 | run 成功写入 hash 后，编辑并撤销回已审内容 | 触发现有 stale 清理 | `expect(clearFileStaleMarkers).toHaveBeenCalledWith(filePath)` |
| runStaged 入口下撤销未保存改动可清理待复审 | runStaged 成功写入 hash 后，编辑并撤销回已审内容 | 触发现有 stale 清理 | `expect(clearFileStaleMarkers).toHaveBeenCalledWith(filePath)` |

## Migration Plan

- 无数据迁移。仅更新 run/runStaged 成功路径的状态写入逻辑与对应测试。
- 上线后立即生效；若出现回归，可回滚该变更并恢复原写入路径。

## Open Questions

- runStaged 的“输入内容 hash”应以 staged patch 还是最终提交给引擎的拼接内容计算：实现前需以当前代码路径定义为准并在测试固定该约定。

## 实现难度与风险评估

- **实现难度**：低到中。改动集中在 `extension.ts` 的两个命令成功分支和测试补充。
- **风险评估**：中低。核心风险在 hash 来源一致性，通过测试可有效约束。
