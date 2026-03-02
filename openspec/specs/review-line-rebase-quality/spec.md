# review-line-rebase-quality

本地行号重映射的可观测性与稳定性：issue 在文档编辑后的行号追踪、多 contentChanges 下的确定性映射、等量删除一致性。

## Requirements

### Requirement: 定位置信度驱动的高亮降级
系统在本地重映射后 MUST 对定位结果给出可判定的置信度，并依据置信度决定是否进入精确高亮，避免错误坐标被强制展示为准确结果。

#### Scenario: 低置信度结果降级展示
- **WHEN** 映射结果经校验为低置信度（例如边界失配、锚点不足或版本不一致）
- **THEN** 系统 MUST 不将该结果作为精确高亮目标
- **AND** 系统 MUST 以可复查方式展示该 issue（保留 stale/lineTrace 等兼容信息）

#### Scenario: 二次重定位成功后恢复高亮
- **WHEN** 初始映射为低置信度，且通过 `astRange` 或 snippet 上下文在限定窗口内完成二次重定位
- **THEN** 系统 MUST 将 issue 更新到重定位后的有效行
- **AND** 系统 MUST 将置信度提升到可高亮级别后再执行高亮

### Requirement: 文档版本一致性门控
系统在处理本地重映射与高亮前 MUST 校验结果版本与文档版本一致性，避免旧结果错误定位到新文档。

#### Scenario: 结果版本落后时阻止错误高亮
- **WHEN** issue 所属审查结果版本早于当前文档版本
- **THEN** 系统 MUST 阻止该 issue 进入精确高亮流程
- **AND** 系统 MUST 保持现有 stale 语义兼容，不引入新的用户配置开关

### Requirement: 本地重映射结果可观测
系统在 issue 发生本地行号重映射后 MUST 保留可追踪的原始行号与重排行号信息，并用于 UI 展示与排查；当定位决策受置信度或版本门控影响时，系统 MUST 保留可诊断的内部原因信息。

#### Scenario: stale 问题展示原始行与重排行
- **WHEN** 同一文件问题因文档编辑被标记为 stale 且触发本地重映射
- **THEN** 系统 MUST 记录该问题的原始行号与重排行号
- **AND** Hover 或等效详情视图 MUST 能展示“原始行 -> 当前行”

#### Scenario: 受门控影响的问题可诊断
- **WHEN** issue 因低置信度或版本不一致被降级
- **THEN** 系统 MUST 保留可用于排查的内部原因信息
- **AND** 不得破坏现有 UI 展示兼容性与字段读取路径

#### Scenario: 未重映射问题保持简洁展示
- **WHEN** 问题未发生本地重映射
- **THEN** 系统 MUST 不强制显示重排追踪字段
- **AND** 现有树节点/详情展示行为 MUST 保持兼容

### Requirement: 多变更事件下行号映射稳定且可重复
系统对单次 `TextDocumentChangeEvent` 内多个 `contentChanges` 的行号重映射 MUST 具有确定性，避免累计偏移；对同一起始行多变更组合与连续编辑事件，映射结果 MUST 与文档真实变更序列一致。

#### Scenario: 复合编辑顺序下结果稳定
- **WHEN** 单次事件同时包含插入、删除与替换变更
- **THEN** 对同一输入 issue 行号应得到确定且可重复的映射结果
- **AND** 多次重复执行同一映射计算结果 MUST 一致

#### Scenario: 同一起始行多变更组合结果确定
- **WHEN** 单次事件内存在多个 `contentChanges` 具有相同起始行且包含插入与替换/删除组合
- **THEN** 映射结果 MUST 与按文档真实应用顺序计算得到的结果一致
- **AND** 不得因内部排序策略引入额外偏移

#### Scenario: 同一文件连续编辑不产生累计漂移
- **WHEN** 同一文件短时间连续触发多次 `TextDocumentChangeEvent` 并基于上次结果继续映射
- **THEN** 最终映射行号 MUST 等于按时间顺序应用全部变更后的真实目标行
- **AND** 不应出现持续累加或抵消的系统性偏移

#### Scenario: AST 范围映射后保持有效边界
- **WHEN** issue 含 `astRange` 且变更覆盖其边界行
- **THEN** 映射后的 `astRange.startLine` 与 `astRange.endLine` MUST 保持有效顺序
- **AND** 映射后范围 MUST 位于文档有效行号区间内

### Requirement: 等量删除场景应保持映射一致性
系统对“删除空行”与“删除非空行”等等量行删除输入 MUST 产生一致的行号重映射结果；映射行为 MUST 基于结构性行变化而非被删除文本内容差异。

#### Scenario: 删除空行与非空行行为一致
- **WHEN** 两组变更仅删除内容不同（空行 vs 非空行）但删除行数与区间一致
- **THEN** 对同一 issue 行号输入，映射输出 MUST 一致
- **AND** 高亮定位 MUST 落在同一目标行

#### Scenario: 批量改写后的一致性不退化
- **WHEN** 文档经历批量改写（如格式化或导入整理）且触发等量或近等量行结构变化
- **THEN** 系统 MUST 保持映射规则一致且可复现
- **AND** 现有 stale_only 合并与展示语义 MUST 不发生退化
