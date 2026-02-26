# review-line-rebase-quality

本地行号重映射的可观测性与稳定性：issue 在文档编辑后的行号追踪、多 contentChanges 下的确定性映射、等量删除一致性。

## Requirements

### Requirement: 本地重映射结果可观测
系统在 issue 发生本地行号重映射后 MUST 保留可追踪的原始行号与重排行号信息，并用于 UI 展示与排查。

#### Scenario: stale 问题展示原始行与重排行
- **WHEN** 同一文件问题因文档编辑被标记为 stale 且触发本地重映射
- **THEN** 系统应记录该问题的原始行号与重排行号
- **AND** Hover 或等效详情视图应能展示“原始行 -> 当前行”

#### Scenario: 未重映射问题保持简洁展示
- **WHEN** 问题未发生本地重映射
- **THEN** 系统不应强制显示重排追踪字段
- **AND** 现有树节点/详情展示行为保持兼容

### Requirement: 多变更事件下行号映射稳定且可重复
系统对单次 `TextDocumentChangeEvent` 内多个 `contentChanges` 的行号重映射 MUST 具有确定性，避免累计偏移。

#### Scenario: 复合编辑顺序下结果稳定
- **WHEN** 单次事件同时包含插入、删除与替换变更
- **THEN** 对同一输入 issue 行号应得到确定且可重复的映射结果
- **AND** 多次重复执行同一映射计算结果应一致

#### Scenario: AST 范围映射后保持有效边界
- **WHEN** issue 含 `astRange` 且变更覆盖其边界行
- **THEN** 映射后的 `astRange.startLine` 与 `astRange.endLine` MUST 保持有效顺序
- **AND** 映射后范围 MUST 位于文档有效行号区间内

### Requirement: 等量删除场景应保持映射一致性
系统对“删除空行”与“删除非空行”这类等量行删除输入 MUST 产生一致的行号重映射结果。

#### Scenario: 删除空行与非空行行为一致
- **WHEN** 两组变更仅删除内容不同（空行 vs 非空行）但删除行数与区间一致
- **THEN** 对同一 issue 行号输入，映射输出应一致
- **AND** 高亮定位应落在同一目标行
