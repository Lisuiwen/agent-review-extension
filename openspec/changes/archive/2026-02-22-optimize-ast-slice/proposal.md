# AST 切片优化

## Why

当前 AST 切片流程对多文件顺序执行、单文件内全树解析且大节点会触发整文件回退，导致提交前/保存复审时切片阶段耗时偏长；同时片段数量多、送审内容偏长，增加大模型 token 消耗与成本。本变更通过「切片过程提速」与「送审内容更短」两方面优化，在保持审查范围语义的前提下提升性能并节省 token。

## What Changes

- **AST 多文件并行**：在 `buildAstSnippetsByFile` 中对多个文件的读文件与 `getAffectedScopeWithDiagnostics` 做并行执行（如 `Promise.all` + 可控并发），缩短多文件场景下的切片总耗时。
- **AST 少解析**：在单文件内减少不必要的解析或遍历成本；例如大文件可配置为仅做 diff 切片而不做 AST 解析，或对不支持的扩展名尽早跳过，避免无效解析。
- **送审内容偏短**：通过相邻片段合并（间隔 ≤ 若干行的 snippet 合并为一段）、以及批内按字符/预估 token 做预算控制，减少「# 行 N」等重复结构，使送审内容更紧凑、token 更少。
- **大节点不回退**：当某 AST 节点行数超过 `maxNodeLines` 时，对该节点截断（如只取前 `maxNodeLines` 行）并继续输出其余片段，不再因单一大节点导致整文件回退为 diff/整文件送审，从而避免送审体积暴增。

## Capabilities

### New Capabilities

- `ast-slice-optimization`: 覆盖 AST 切片在「多文件并行、少解析、送审更短、大节点截断不回退」四类行为与可配置项，以及与现有 diff/批处理模式的衔接。

### Modified Capabilities

- （无：当前 `openspec/specs/` 下无既有 spec，不涉及既有能力的需求变更。）

## Impact

- **测试**：需新增多文件并发、大节点截断与相邻合并的单测，与 design「测试与验证」及 tasks 一致。
- **受影响代码**：`src/core/reviewEngine.ts`（`buildAstSnippetsByFile` 的并行与调用方式）、`src/utils/astScope.ts`（大节点截断、可选相邻合并与少解析相关逻辑）、`src/ai/aiReviewer.batching.ts`（批预算按字符/预估 token 的可选策略）。
- **配置**：可能新增或复用 AST/审查相关配置项（如并行度、是否合并相邻片段、大文件是否跳过 AST 等），具体在 design 与 tasks 中落实。
- **API/依赖**：不引入新运行时依赖；仅使用现有 Babel/Vue 解析与 Node/VSCode API。
- **系统**：仅影响本地审查引擎的切片与送审内容生成，不影响规则引擎、LSP 或 AI 接口契约。
