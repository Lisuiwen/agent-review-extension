# AST 切片优化 - 实现任务

## 1. astScope：大节点截断与相邻合并

- [x] 1.1 在 astScope 的 JS/TS 路径中，将「节点行数 > maxNodeLines 时整文件返回 null」改为「该节点截断为前 maxNodeLines 行加入 snippets，继续处理其余节点」
- [x] 1.2 在 astScope 的 Vue 路径（script/scriptSetup/template）中，对大节点同样改为截断后加入 snippets，不 skip 整节点
- [x] 1.3 在 AstScopeOptions 中新增 mergeSnippetGapLines（可选，默认 1）；在 getAffectedScopeWithDiagnostics 输出前对已排序 snippets 做相邻合并（间隔 ≤ K 则合并），K<0 时不合并
- [x] 1.4 为 mergeAdjacentSnippets 与截断逻辑补充/调整 astScope 单测（截断不回退、合并 K≥0、K<0 关闭；与 design「测试与验证」中对应用例设计一致）

## 2. 配置与调用传参

- [x] 2.1 在 reviewEngine 调用 getAffectedScopeWithDiagnostics 时传入 mergeSnippetGapLines（从 config.ast 或默认 1 读取）；若存在 ast.merge_snippet_gap_lines 配置项则接入并写入 types/config 与 configManager
- [x] 2.2 确认 maxFileLines / maxNodeLines 已正确从 config.ast 传入，保证大文件早退与截断行为一致

## 3. reviewEngine：多文件并行

- [x] 3.1 在 buildAstSnippetsByFile 内对「有 diff 的文件」列表做并发执行（Promise.all + 固定并发数，如 chunk 分批或简单池），结果合并为 Map<filePath, AffectedScopeResult>
- [x] 3.2 新增 AST 切片并发数配置（如 ast.slice_concurrency），默认 4 或 8；并发数为 1 时保持顺序执行，与现有行为一致
- [x] 3.3 在 package.json / configManager 中暴露切片并发数配置项（若尚未存在）

## 4. 单测与回归（与 design「测试与验证」一致）

- [x] 4.1 为「多文件并发且结果正确」「并发数=1 时顺序」增加 reviewEngine 或集成层单测（对应 design 中上述两条用例设计）
- [x] 4.2 运行现有 astScope、aiReviewer、reviewEngine 相关单测，确保无回归

## 5. 可选：批预算按字符

- [x] 5.1 在 splitUnitsBySnippetBudget 或 buildReviewUnits 中增加可选「按字符数」权重（如 unit.content 长度或 estimateRequestChars），配置项如 ast_chunk_weight_by: snippet_count | chars，默认 snippet_count
- [x] 5.2 为按字符分批增加单测并验证与 batch_concurrency 配合
