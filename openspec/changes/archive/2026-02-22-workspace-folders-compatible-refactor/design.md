# 工作区根解析兼容性重构 - 设计

## Context

- 当前代码在 ConfigManager、FileScanner、ReviewEngine、extension、ignoreIssueCommand、runtimeLogPath、reviewEngine.runSummary 等多处直接使用 `vscode.workspace.workspaceFolders?.[0]`，无统一抽象。
- 目标：引入「有效工作区根」统一解析，单根行为不变，为多根预留扩展点；**不交付多根功能**。验收重点为**回归**：单根场景零行为变化，现有单根相关测试全部通过。

## Goals / Non-Goals

**Goals:**

- 提供单一入口（如 `getEffectiveWorkspaceRoot()`）返回当前「有效工作区根」（单根 = `workspaceFolders[0]`）。
- 所有原 `workspaceFolders?.[0]` 调用点改为使用该入口或显式传入由其得到的根参数。
- 单根下行为与重构前完全一致；无工作区时行为与现有一致。
- 通过现有单根测试及可选的新单测验证回归。

**Non-Goals:**

- 不实现多根 UI、不按根分 result、不改变用户可见能力。
- 不在本变更中实现「按活动编辑器所在 folder」解析（仅预留扩展点，如入口签名可接受可选 `resourceUri`）。

## Decisions

1. **统一入口形态**  
   - 在 extension 或公共 util 中提供 `getEffectiveWorkspaceRoot(): vscode.WorkspaceFolder | undefined`（或返回 `uri.fsPath` 的 string | undefined，与现有调用方期望一致）。  
   - 实现：`workspaceFolders?.length === 0 || !workspaceFolders` → `undefined`；否则 `workspaceFolders[0]`。多根时仍取第一个，与当前行为一致，后续可改为「活动编辑器所在 folder」而不影响本步验收。

2. **调用点改造方式**  
   - 各模块通过调用 `getEffectiveWorkspaceRoot()` 获取根，再取 `?.uri.fsPath` 等；或接收从上层传入的 `workspaceRoot: string | undefined`，上层由该入口得到。  
   - 不改变各模块对外 API（如 ConfigManager.getConfig() 仍无参；内部用统一入口得到根再读该根下配置）。

3. **ConfigManager / FileScanner**  
   - ConfigManager：构造或首次需要根时调用统一入口，得到根后计算 configPath/envPath；watcher 仍针对该根。  
   - FileScanner：构造时或每次需要根时使用统一入口；若需支持「按根扫描」，可改为方法级传入 root（本变更内单根调用方传入统一入口结果即可）。

4. **ReviewEngine / runSummary / ignoreStore**  
   - 入口方法（如 review、reviewStagedFiles、reviewPendingChangesWithContext）所需根由调用方（extension/commands）通过统一入口获取并传入，或 Engine 内部在单点调用统一入口，避免在 Engine 内部多处再写 `[0]`。  
   - runSummary、ignoreStore 等已接受 `workspaceRoot: string` 的保持；调用方传入由统一入口得到的值。

5. **extension.ts（getGitRoot、保存门控等）**  
   - getGitRoot：内部用统一入口得到 workspaceRoot 再向上查找 .git。  
   - 保存门控等已有 `workspaceFolders?.length` 判断的保留；需要「一个根」时改用统一入口。

## Risks / Trade-offs

- **[Risk] 漏改某处 [0]**  
  **Mitigation**：全文搜索 `workspaceFolders?.[0]` 及 `workspaceFolders?.[0]` 变体，逐处替换或传参；完成后再次 grep 确认无遗漏（测试与 mock 除外，mock 可保留单根数组）。

- **[Risk] 单根行为漂移**  
  **Mitigation**：统一入口在单根时严格等价于 `workspaceFolders[0]`；以现有单根相关单测与集成测试通过为回归基线，必要时补充「有效根解析」的单元测试。

- **[Trade-off] 多根时仍用 [0]**  
  当前多根场景下仍取第一个 folder，与现在一致；不在此变更中实现「活动编辑器所在 folder」。扩展点可通过后续在统一入口增加可选参数（如 `resourceUri`）实现。

## 测试与验证

本变更以**回归验证**为主：确保单根行为不变；可选增加对「有效根解析」本身的单元测试。

| Scenario（对应 spec） | 覆盖策略 | 测什么 | 条件 | 期望 | 断言要点 |
|----------------------|----------|--------|------|------|----------|
| 无工作区文件夹 | 已有/需补充 | 有效根解析无 folder 时返回无根 | workspaceFolders 为 [] 或 undefined | 返回 undefined（或与现有无根逻辑一致） | `expect(getEffectiveWorkspaceRoot()).toBeUndefined()` 或等价 |
| 单根工作区 | 已有/需补充 | 有效根解析单根时等于 [0] | workspaceFolders 为单元素数组 | 返回该 folder（或其 fsPath） | `expect(getEffectiveWorkspaceRoot()).toBe(workspaceFolders[0])` 或 fsPath 相等 |
| 多根兼容预留 | 可选 | 多根时返回第一个 folder | workspaceFolders 为多元素数组 | 返回 [0] | 与单根一致策略，可同单根用例扩展 |
| 单根回归 | 已有 | 配置/扫描/审查/忽略/日志等单根行为不变 | 单根工作区；执行配置加载、run、runStaged、ignore、runtimeLog 等 | 行为与重构前一致 | 现有单根相关单测与集成测试全部通过（configManager、fileScanner、reviewEngine、extension、ignoreIssue、runtimeLogPath 等） |
| 无根不崩溃 | 已有 | 无 folder 时依赖根的流程不抛异常 | workspaceFolders 为空；触发依赖根的逻辑 | 提前返回或 fallback，不抛 | 现有无 folder 的测试或新用例中 expect 无 throw |

**目标文件与已有覆盖：**

- 新增：可选的 `src/__tests__/utils/workspaceRoot.test.ts`（或类似）仅覆盖 `getEffectiveWorkspaceRoot` 的 0/1/多 folder 分支。
- 已有：`configManager.test.ts`、`fileScanner.test.ts`、`reviewEngine*.test.ts`、`ignoreIssueCommand.test.ts`、`runtimeLogPath.test.ts`、`autoReviewController.test.ts`、`runReviewCommand.test.ts`、`runStagedReviewCommand.test.ts` 等保持单根 mock，作为回归基线；实现后全量运行并确认通过。

**说明：** 本变更不采用 TDD 强制先写失败用例；以回归通过为主，可选为统一入口补单测。

## Migration Plan

1. 实现 `getEffectiveWorkspaceRoot()` 并落单测（可选）。
2. 按模块替换所有 `workspaceFolders?.[0]` 使用点为统一入口或传入根参数；每改一模块可跑一次相关测试。
3. 全文 grep 确认无遗漏（排除测试 mock）。
4. 运行完整单测与集成测试，确认单根回归通过。

无线上部署与回滚；本地/CI 验证即可。

## Open Questions

- 无。多根时「活动编辑器所在 folder」留作后续变更。

## 实现难度与风险评估

- **实现难度**：中低。改动点清晰（单一入口 + 替换调用点），无新算法；工作量约 1–2 天（含回归验证）。
- **回归风险**：中。通过「单根等价于 [0]」的严格约定与完整单根测试通过作为验收条件，可控制在可接受范围。
