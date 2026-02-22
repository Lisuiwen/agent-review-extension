# AST 切片优化 - 技术设计

## Context

- **当前状态**：`reviewEngine.buildAstSnippetsByFile` 对 `targetFiles` 顺序循环，逐文件 `readFile` + `getAffectedScopeWithDiagnostics`。单文件内：Babel/Vue 整文件解析 → `collectSmallestNodes` 全树遍历 → 去重、去包含、排序后输出 snippets。若某节点行数超过 `maxNodeLines`，整文件返回 null，上层回退为 diff 或整文件送审。批内按 snippet **个数** 做 `splitUnitsBySnippetBudget`。
- **约束**：不引入新运行时依赖；需保持与现有 diff 模式、`ast_snippet` / `file_count` 批处理模式的兼容；扩展名与 fallback 语义不变。
- **干系人**：本地审查引擎使用者（提交前/保存复审），关注延迟与 AI 调用成本。

## Goals / Non-Goals

**Goals:**

- 多文件 AST 切片总耗时下降（通过并行）。
- 单文件内减少无效解析（大文件可配置跳过 AST）。
- 送审内容更短、token 更少：相邻片段合并、大节点截断不回退；可选批预算按字符。
- 行为与现有配置、fallback 链兼容，可配置、可关闭。

**Non-Goals:**

- 不改变 LSP、规则引擎、AI 接口契约；不替换 Babel/Vue 解析器；不实现「按行索引 AST」等复杂算法（仅用现有全树遍历）。

## Decisions

### D1：多文件并行策略

- **选择**：在 `buildAstSnippetsByFile` 内对「有 diff 的文件」并发执行单文件逻辑（readFile + getAffectedScopeWithDiagnostics），用固定并发数上限（如 4–8）避免同时解析过多大文件。
- **实现要点**：用 `Promise.all` + 简单并发池（例如对 targetFiles 按 chunk 分批 `Promise.all`，或使用小型 worker 池），保证结果仍为 `Map<filePath, AffectedScopeResult>`，与现有调用方一致。
- **替代**：无上限的 `Promise.all` 可能在大仓库时内存与 CPU 尖峰 → 不采用。顺序执行保留为配置项（并发数=1）即可兼容。

### D2：大文件「少解析」

- **选择**：沿用现有 `maxFileLines`；当文件行数超过该值时 `getAffectedScopeWithDiagnostics` 已返回 null，上层用 diff。不在此变更中新增「大文件强制跳过 AST」的独立开关，避免与现有 `ast.max_file_lines` 语义重复。
- **可选增强**：若配置中存在「超过 N 行不解析 AST」的显式开关，可映射为在传入 `getAffectedScopeWithDiagnostics` 前根据 `content.split('\n').length` 与 N 比较直接返回 null，减少一次 Babel 解析调用。此为可选，在 tasks 中按需实现。

### D3：大节点截断不回退

- **选择**：在 `astScope.ts`（JS/TS 与 Vue 两路径）中，当某节点行数 `lineCount > maxNodeLines` 时，不返回 `fallbackReason: 'maxNodeLines'` 导致整文件 null，而是将该节点**截断**为前 `maxNodeLines` 行（`endLine = startLine + maxNodeLines - 1`，截取对应 source）加入 snippets，继续处理其余节点。
- **理由**：单一大函数/大块不再拖垮整文件，送审体积可控；审查范围仍以变更行为主，截断处为同一节点前半段，语义可接受。
- **替代**：整节点丢弃仅输出其他节点 → 可能漏审该变更区域，故不采用。

### D4：相邻片段合并（送审更短）

- **选择**：在 `getAffectedScopeWithDiagnostics` 输出前，对已去重、去包含、排序后的 snippets 做一步**合并**：若两片段间隔 ≤ K 行（K 可配置，默认 1），合并为一段（startLine 取小、endLine 取大，source 从 lines 重新截取）。合并后减少「# 行 N」与重复结构，从而省 token。
- **实现**：单次线性扫描已排序的 snippets，维护当前区间，若下一段与当前段间隔 ≤ K 则扩展当前区间，否则输出当前并开始新区间。K=0 表示仅重叠或紧邻才合并；K<0 可表示关闭合并（与现有行为一致）。
- **替代**：不合并 → 保持现状，token 更多；按「同一函数」合并需要 AST 父节点信息，实现成本高，本期不做。

### D5：批预算按字符（可选）

- **选择**：在 `splitUnitsBySnippetBudget` 或 buildReviewUnits 的权重计算中，**可选**增加「按字符数」策略：单元权重 = 当前 snippetCount 或改为 `estimateRequestChars`（或按 unit.content 长度近似），使每批 token 更均衡，避免某批过长触发 413/context_length。
- **范围**：作为可选策略或新配置项（如 `ast_chunk_weight_by`：`snippet_count` | `chars`），默认保持现有按 snippet 个数行为，保证兼容。
- **替代**：仅按 snippet 个数 → 实现简单但某批可能很长；本期可在 tasks 中列为可选实现。

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| 并行导致单次内存与 CPU 峰值升高 | 限制并发数（如 4–8），并可配置为 1 退化为顺序 |
| 相邻合并后单段变长，单次请求略长 | 合并仅针对间隔 ≤1 行，段数减少带来的「# 行 N」节省通常大于单段略长成本；可配置 K 或关闭 |
| 大节点截断导致该节点后半未送审 | 接受为已知限制；变更行若集中在前半，审查仍有效；可在 UI/文档中说明 |
| 批按字符权重与现有按个数不一致 | 默认保持按个数；按字符作为可选策略，需测试与现有 batch_concurrency 的配合 |

## Migration Plan

- **部署**：代码合并后，新行为由配置控制（并行度、合并间隔、大节点截断为默认开启、批权重可选）。无数据迁移。
- **回滚**：将并行度设为 1、合并间隔设为 -1（或关闭）、以及保留「大节点返回 null」的旧分支（或配置）即可回退；若已删除旧分支，通过配置最小化新行为影响。

## 测试与验证

本变更涉及的 spec Scenario、覆盖策略及目标文件见下表（与 specs/ast-slice-optimization/spec.md 对应）。需新增的用例设计采用「测什么 / 条件 / 期望 / 断言要点」格式（见 openspec/测试用例设计与实现规范.md §2）；是否采用 TDD：截断与相邻合并逻辑可先写断言再实现，适合 TDD，可参考 .cursor/skills/tdd-workflow.md。

### Scenario 覆盖总览

| Scenario（要点） | 覆盖策略 | 目标文件 / 任务 |
|------------------|----------|------------------|
| 多文件时并发执行且结果正确 | 需新增 | reviewEngine 或集成层（tasks 4.1） |
| 并发数为 1 时顺序执行 | 需新增 | 同上（tasks 4.1） |
| 单节点超 maxNodeLines 时截断并继续 | 需新增/调整 | astScope.test.ts（tasks 1.4） |
| 所有节点均不超限时行为不变 | 已有 | astScope.test.ts 现有用例 |
| 间隔不超过 K 时合并 | 需新增 | astScope.test.ts（tasks 1.4） |
| 合并关闭时保持原样（K<0） | 需新增 | astScope.test.ts（tasks 1.4） |
| 超过 maxFileLines 时返回 null | 已有 | astScope 现有大文件/早退相关用例 |
| 不支持扩展名时返回 null | 已有 | astScope 扩展名相关行为 |
| 默认按个数时行为不变 / 启用按字符时批次受字符约束 | 可选 | 若实现 5.1/5.2，则 tasks 5.2 单测 |

### 需新增用例设计（测什么 / 条件 / 期望 / 断言要点）

| 测什么 | 条件 | 期望 | 断言要点 |
|--------|------|------|----------|
| 多文件并发执行且结果正确 | targetFiles 至少 2 个有 diff 的文件，并发数 > 1；buildAstSnippetsByFile 调用 | 各文件并发执行，返回 Map 中每路径对应该文件的 AffectedScopeResult | `expect(map.size).toBe(targetFiles.length)`；每 key 对应路径；每 value 形态符合 AffectedScopeResult |
| 并发数为 1 时顺序执行 | 并发数配置为 1，多文件调用 buildAstSnippetsByFile | 行为与顺序执行一致，结果与未并行前一致 | 结果 Map 与顺序实现结果一致（可对比 snippet 顺序或结果快照） |
| 单节点超 maxNodeLines 时截断并继续 | 某节点行数 > options.maxNodeLines；content + fileDiff 构造出该节点 | result 非 null；该节点只取前 maxNodeLines 行；其余节点正常输出 | `expect(result).not.toBeNull()`；该 snippet 的 `endLine - startLine + 1 <= maxNodeLines`；snippets 数量/内容符合预期 |
| 所有节点均不超限时行为不变 | 所有节点行数均 ≤ maxNodeLines | 输出片段与未引入截断逻辑前一致 | 片段数、各 snippet 的 startLine/endLine/source 与基准一致 |
| 间隔不超过 K 时合并（K≥0） | 已排序 snippets 中两段间隔 ≤ K（K≥0） | 两段合并为一段，输出片段数减少，合并段 source 覆盖合并后行范围 | 合并后 snippets 数减少；合并段 startLine/endLine 为两段最小/最大；source 覆盖该行范围 |
| 合并关闭时保持原样（K<0） | 合并间隔配置 K<0 或关闭合并 | 不进行合并，输出与未引入合并逻辑前一致 | snippets 数量与顺序与不合并时一致 |

- **已有测试文件**：`src/__tests__/utils/astScope.test.ts`、`src/__tests__/core/reviewEngine.optimization.test.ts`。
- **需新增/修改**：astScope 截断与合并逻辑的单测（tasks 1.4）；reviewEngine 多文件并发与并发数=1 的单测（tasks 4.1）。无特殊 mock，沿用现有 tempFileSystem / mock 即可。实现后可在本表或总览中更新「已有覆盖」。

## Open Questions

- 并发数默认值（4 vs 8）是否需要在首次发布前根据典型仓库规模压测确定。
- 「批预算按字符」是否纳入首版实现，还是留作后续迭代。
