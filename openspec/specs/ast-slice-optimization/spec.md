# AST 切片优化 - 需求规格

## Purpose

AST 切片在「多文件并行、大节点截断、相邻片段合并、大文件/扩展名早退、批预算按字符」等行为与可配置项上的能力规格；与 diff/批处理模式衔接。

## Requirements

### Requirement: 多文件 AST 切片并行执行

构建 AST 片段时，系统 SHALL 对多个有 diff 的文件并发执行「读文件 + getAffectedScopeWithDiagnostics」，且 SHALL 支持可配置的并发数上限；当并发数配置为 1 时，行为 SHALL 与顺序执行一致。输出 SHALL 仍为按文件路径映射的 AffectedScopeResult，与现有调用方契约一致。

#### Scenario: 多文件时并发执行且结果正确

- **WHEN** buildAstSnippetsByFile 被调用且 targetFiles 包含至少 2 个有 diff 的文件、并发数配置大于 1
- **THEN** 各文件的读文件与 AST 切片逻辑并发执行，且返回的 Map 中每个文件路径对应该文件的 AffectedScopeResult（或无结果时不包含该 key）

#### Scenario: 并发数为 1 时顺序执行

- **WHEN** 并发数配置为 1
- **THEN** 各文件按顺序依次执行读文件与 getAffectedScopeWithDiagnostics，行为与未引入并行前一致

---

### Requirement: 大节点截断不回退

当某 AST 节点行数超过配置的 maxNodeLines 时，系统 SHALL 将该节点截断为前 maxNodeLines 行并加入输出片段列表，SHALL 继续处理并输出其余节点片段，SHALL NOT 因该单一大节点而返回整文件 null（即不再触发 fallbackReason: 'maxNodeLines' 导致上层回退为 diff/整文件送审）。

#### Scenario: 单节点超 maxNodeLines 时截断并继续

- **WHEN** getAffectedScopeWithDiagnostics 处理某文件且某节点行数大于 options.maxNodeLines
- **THEN** 该节点以截断后的前 maxNodeLines 行作为一个 snippet 输出，且该文件其余有效节点片段仍正常输出，result 非 null

#### Scenario: 所有节点均不超限时行为不变

- **WHEN** 所有节点行数均不超过 maxNodeLines
- **THEN** 输出片段与未引入截断逻辑前一致（无截断发生）

---

### Requirement: 相邻片段可合并以缩短送审内容

系统 SHALL 在输出 AST 片段前，支持将「行号间隔不超过 K 行」的相邻片段合并为一段（K 可配置，默认 1）；K<0 时 SHALL 关闭合并，保持原有逐片段输出。合并后的 snippet SHALL 使用合并区间的 startLine/endLine 及对应 source，以便减少送审内容中的「# 行 N」等重复结构，节省 token。

#### Scenario: 间隔不超过 K 时合并

- **WHEN** 已排序的 snippets 中存在两段，后段 startLine 与前段 endLine 的间隔 ≤ K（K≥0）
- **THEN** 该两段被合并为一段，输出片段数减少，且合并段 source 覆盖合并后的行范围

#### Scenario: 合并关闭时保持原样

- **WHEN** 合并间隔配置为 K<0（或关闭合并）
- **THEN** 不进行合并，输出与未引入合并逻辑前一致

---

### Requirement: 大文件与扩展名早退（少解析）

系统 SHALL 在单文件 AST 切片前，对不支持的扩展名尽早返回 null，SHALL 在文件行数超过配置的 maxFileLines 时返回 null（不执行 Babel/Vue 解析）。可选：若配置了「超过 N 行不解析 AST」的显式开关，系统 MAY 在解析前根据文件行数与 N 比较并直接返回 null，以减少无效解析调用。

#### Scenario: 超过 maxFileLines 时返回 null

- **WHEN** getAffectedScopeWithDiagnostics 被调用且 content 行数大于 options.maxFileLines
- **THEN** 返回 result 为 null 及相应 fallbackReason，不执行整文件 AST 解析

#### Scenario: 不支持扩展名时返回 null

- **WHEN** 文件扩展名不在支持的 AST 切片列表（如 .js/.jsx/.ts/.tsx/.vue）内
- **THEN** 返回 result 为 null 及 unsupportedExt（或等效），不执行解析

---

### Requirement: 批预算可选按字符（可选能力）

系统 MAY 支持批内按「字符数」或「预估请求字符数」对单元加权，使 splitUnitsBySnippetBudget 或等效逻辑在划分批次时限制每批总字符/token 量；若未启用该策略，SHALL 保持现有按 snippet 个数加权的行为，保证兼容。

#### Scenario: 默认按个数时行为不变

- **WHEN** 未配置或未启用「按字符」批预算策略
- **THEN** 批划分仍按 snippet 个数（或现有权重）计算，与当前实现一致

#### Scenario: 启用按字符时批次受字符上限约束

- **WHEN** 配置启用按字符（或预估 token）加权且某批累计权重超过配置上限
- **THEN** 该批在达到上限时结束，下一单元进入新批，使单批送审体积更可控
