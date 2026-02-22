# 任务列表：no_pending_diff 时清除该文件在面板中的 issue

## 1. 复审面板能力

- [x] 1.1 在 `ReviewPanel`（`src/ui/reviewPanel.ts`）中新增 `clearIssuesForFile(filePath: string)`：从 `getCurrentResult()` 取当前 result，过滤掉该文件的所有 issue 后用 `buildResultFromIssues` + `normalizeResultForDisplay` 重组并 `updateResult`，无 result 或过滤无变化时直接 return

## 2. 门控消费者调用

- [x] 2.1 在 `src/extension.ts` 门控跳过分支中，当 `gateDecision.reason === 'no_pending_diff'` 时调用 `readyReviewPanel.clearIssuesForFile(nextPath)`（与 same_content 分支调用 clearFileStaleMarkers 对称）

## 3. 测试

- [x] 3.1 在 `src/__tests__/extension/autoReviewController.test.ts` 中新增用例：mock 门控返回 `skip: true, reason: 'no_pending_diff'`，断言 `clearIssuesForFile` 以该文件路径被调用一次（与 design「测试与验证」中「no_pending_diff 时 extension 调用面板按文件清除 issue」一致）
