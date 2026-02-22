# run-staged-hash-consistency

统一 `agentreview.run` 与 `agentreview.runStaged` 的已审内容哈希持久化语义，确保撤销未保存改动时可基于现有逻辑清理待复审标记。

## Requirements

### Requirement: run 入口成功应用后必须持久化已审内容哈希

当用户通过 `agentreview.run` 触发审查且结果被成功应用时，系统 MUST 将本次实际审查内容对应的哈希写入该文件状态的 `lastReviewedContentHash`。若本次结果未被应用（失败、过期、取消或异常），系统 MUST NOT 更新 `lastReviewedContentHash`。

#### Scenario: run 成功后写入 hash
- **WHEN** 用户执行 `agentreview.run` 且审查结果成功并被应用
- **THEN** 该文件 `lastReviewedContentHash` 被更新为本次 run 审查内容哈希

#### Scenario: run 结果未应用时不写入 hash
- **WHEN** 用户执行 `agentreview.run` 但结果失败、过期或未被应用
- **THEN** 该文件 `lastReviewedContentHash` 保持原值不变

### Requirement: runStaged 入口成功应用后必须持久化已审内容哈希

当用户通过 `agentreview.runStaged` 触发审查且结果被成功应用时，系统 MUST 将本次 staged 审查输入对应的内容哈希写入该文件状态的 `lastReviewedContentHash`。若本次结果未被应用（失败、过期、取消或异常），系统 MUST NOT 更新 `lastReviewedContentHash`。

#### Scenario: runStaged 成功后写入 hash
- **WHEN** 用户执行 `agentreview.runStaged` 且审查结果成功并被应用
- **THEN** 该文件 `lastReviewedContentHash` 被更新为本次 staged 审查输入内容哈希

#### Scenario: runStaged 结果未应用时不写入 hash
- **WHEN** 用户执行 `agentreview.runStaged` 但结果失败、过期或未被应用
- **THEN** 该文件 `lastReviewedContentHash` 保持原值不变

### Requirement: run 与 runStaged 必须与现有 stale 清理逻辑兼容

系统 MUST 保持现有 stale 清理规则不变：当 `onDidChangeTextDocument` 计算出的 `currentHash === lastReviewedContentHash` 时，清理该文件待复审标记。run 与 runStaged 路径写入的 `lastReviewedContentHash` 必须使“编辑后撤销未保存改动”能够命中该规则。

#### Scenario: run 路径下撤销未保存改动触发清理
- **WHEN** 某文件通过 `agentreview.run` 成功审查并写入 `lastReviewedContentHash`
- **AND** 用户后续编辑该文件，再撤销回与该哈希一致的内容
- **THEN** 现有逻辑触发待复审标记清理

#### Scenario: runStaged 路径下撤销未保存改动触发清理
- **WHEN** 某文件通过 `agentreview.runStaged` 成功审查并写入 `lastReviewedContentHash`
- **AND** 用户后续编辑该文件，再撤销回与该哈希一致的内容
- **THEN** 现有逻辑触发待复审标记清理
