## Context

当前实现已完成 `workspace-root-resolution` 的兼容性重构，但语义仍是“多根时取第一个 folder”。因此在多根工作区下，扫描、审查、忽略与运行摘要仍绑定单根上下文，无法表达“问题属于哪个项目”。

本次变更聚焦“先做数据归属”：
- 让审查执行可在多根下聚合运行（仅 Git 项目参与）。
- 让结果模型携带项目归属信息，供后续 UI 分树直接消费。
- 暂不改 TreeView 结构，避免一次性跨越数据层与 UI 层带来的回归面扩张。

约束与偏好（已确认）：
- 结果展示未来采用“项目-规则-文件”分层，但本次不做 UI。
- 审查范围默认仅 Git 项目。
- 并发采用全局共享上限。
- `.vscode/agentreview-ignore.json` 按项目独立；`.agentreview.yaml` 与 `.env` 保持全局统一语义。

## Goals / Non-Goals

**Goals:**
- 在数据层引入“问题归属项目”元数据，保证每条 issue 可追溯到 workspace root。
- 在执行层支持多根聚合审查，并保持全局并发控制。
- 在忽略逻辑上按 issue 归属项目读取/写入 ignore store。
- 保持单根工作区行为与当前一致，不引入破坏性变更。

**Non-Goals:**
- 不修改 TreeView 分树展示与交互。
- 不引入按项目差异化配置解析（`.agentreview.yaml` / `.env` 仍全局）。
- 不在本阶段调整运行日志 schema（仅保证可记录归属，不强制改可视化）。

## Decisions

### 1) 引入多根枚举与定位 API（扩展 workspace-root-resolution）
- 决策：在 `src/utils/workspaceRoot.ts` 增加多根辅助能力（枚举全部 folder、按文件定位 folder、筛选 Git folder），保留 `getEffectiveWorkspaceRoot()` 仅用于旧路径兼容。
- 原因：当前仅返回 `[0]`，不足以支撑聚合执行与归属绑定。
- 备选方案：直接在各模块读取 `workspace.workspaceFolders` 并自行判断。
  - 不选原因：会重复逻辑，增加边界不一致风险。

### 2) 在 `ReviewIssue` 增加归属字段
- 决策：为 `ReviewIssue` 增加可选 `workspaceRoot?: string`，在多根聚合结果中必填，单根下兼容可选。
- 原因：最小成本承载归属信息，兼容现有调用点与测试。
- 备选方案：新增外层 `Map<workspaceRoot, ReviewResult>`。
  - 不选原因：会大范围改动现有 `ReviewPanel/StatusBar/命令` 契约，不符合“先做数据归属”的分阶段目标。

### 3) 新增聚合调度层，统一全局并发
- 决策：新增 coordinator（可放 `src/core`），负责：
  - 枚举 Git workspace folders。
  - 为每个项目构建审查任务。
  - 通过全局并发池执行并合并结果。
- 原因：避免把多根编排塞进 `ReviewEngine` 单文件，保持职责清晰。
- 备选方案：在命令层循环调用 `reviewEngine`。
  - 不选原因：命令层会复制调度逻辑，后续 save/run/runStaged 难复用。

### 4) FileScanner 改为显式 workspaceRoot 入参
- 决策：将 Git/diff 相关方法改为显式传入 `workspaceRoot`，避免构造时固化根路径。
- 原因：当前 `FileScanner` 在构造函数绑定单根，是多根下的核心阻塞点。
- 备选方案：每次执行前重建 `FileScanner` 并切换全局根。
  - 不选原因：隐式状态过多，易引入并发竞态。

### 5) Ignore store 按 issue 归属项目执行
- 决策：过滤与写入 ignore fingerprint 时，使用 issue 的 `workspaceRoot`（或任务上下文 root）访问 `<workspaceRoot>/.vscode/agentreview-ignore.json`。
- 原因：满足“ignore 按项目隔离”的既定策略。
- 备选方案：继续沿单根 ignore store。
  - 不选原因：会导致跨项目互相污染，违背需求。

### 6) 配置/.env 维持全局语义
- 决策：`ConfigManager` 暂不按项目切换 `.agentreview.yaml` / `.env`，沿现有全局读取方式。
- 原因：降低第一阶段复杂度，先稳定数据归属。
- 备选方案：一次性支持按项目配置。
  - 不选原因：会显著扩大回归面，超出本次范围。

## Risks / Trade-offs

- [Risk] 多入口行为不一致（run/runStaged/save）
  → Mitigation：统一通过 coordinator 编排；为三入口补同构多根测试。

- [Risk] 结果去重/过滤误用无归属 issue
  → Mitigation：在合并前对 issue 注入 `workspaceRoot`；缺失时按任务上下文兜底并打日志。

- [Risk] 单根回归（历史测试大量依赖默认根）
  → Mitigation：字段新增保持可选；单根路径保持原默认；回归测试必须全绿。

- [Trade-off] 本阶段不改 UI，用户暂时看不到项目分树
  → Mitigation：先保证数据层正确；下一阶段 UI 只消费已稳定的 `workspaceRoot` 字段。

## Migration Plan

1. 扩展 workspaceRoot 工具能力，新增多根枚举/定位函数（不移除旧 API）。
2. 改造 FileScanner 为显式 `workspaceRoot` 入参，覆盖 staged/pending/working diff 路径。
3. 在 ReviewEngine/聚合调度中传递 `workspaceRoot` 上下文，并在 issue 上写入归属字段。
4. 改造 ignore filter 与 ignore command 的存取路径，按归属项目读写 store。
5. 调整 run/runStaged/save 入口接入聚合调度（本阶段仅数据汇总，不改 UI 节点结构）。
6. 回归与新增测试通过后发布。
7. 回滚策略：保留旧单根入口实现分支，出现严重回归时可临时退回“仅首项目执行”。

## Open Questions

- [Resolved] run summary 在本阶段继续采用“单条聚合”策略，不拆分为每项目一条。多项目运行由命令入口聚合后统一汇总，保持现有日志消费兼容。
- [Resolved] AI 审查失败且 file 为空时，不引入项目级虚拟文件；仅通过 `workspaceRoot` 上下文字段承载归属，避免额外 UI/路径语义。

## 测试与验证

### 覆盖策略
- 以“单根回归不变 + 多根新增场景”双轨验证。
- 优先单元测试（workspaceRoot / FileScanner / ReviewEngine 聚合逻辑）；命令层补关键集成测试。
- 本变更跨模块且含调度逻辑，建议采用 TDD：先补失败用例再实现。

### Scenario 列表与用例设计

| Scenario | 类型 | 测什么 | 条件 | 期望 | 断言要点 | 目标文件 |
|---|---|---|---|---|---|---|
| 多根仅 Git 项目参与 | 新增 | workspace folder 过滤策略 | 3 个 folder（2 Git + 1 非 Git） | 仅 2 个 Git 项目被调度 | 调度任务数=2；非 Git 无审查调用 | `src/__tests__/utils/workspaceRoot.test.ts` 或新增 `src/__tests__/core/multiRootCoordinator.test.ts` |
| issue 归属字段注入 | 新增 | `ReviewIssue.workspaceRoot` 赋值 | 多根聚合返回 issues | 每条 issue 带正确 root | `issues.every(i => i.workspaceRoot===expectedRoot)` | `src/__tests__/core/reviewEngine*.test.ts` |
| ignore 按项目隔离 | 新增 | 相同指纹跨项目不互相影响 | A/B 项目各有 ignore store | A 的 ignore 不过滤 B 的问题 | A 过滤命中、B 不命中 | `src/__tests__/core/reviewEngine*.test.ts`、`src/__tests__/commands/ignoreIssueCommand.test.ts` |
| 全局并发上限生效 | 新增 | 多项目任务共享并发池 | 3 项目、并发上限=2 | 峰值并发不超过 2 | 记录执行峰值 `<=2` | 新增 `src/__tests__/core/multiRootCoordinator.test.ts` |
| run/runStaged 多根聚合 | 新增 | 命令入口结果汇总正确 | 多根均有变更 | 结果包含所有项目问题 | 问题总数=各项目求和；状态正常更新 | `src/__tests__/commands/runReviewCommand.test.ts`、`src/__tests__/commands/runStagedReviewCommand.test.ts` |
| 单根行为回归 | 回归 | 保持原有语义 | 仅单项目 | 输出与旧逻辑一致 | 既有测试无改或最小改动后全绿 | 现有相关测试全集 |

### 特殊 mock/fixture 说明
- 需要在 VSCode mock 中支持 `workspaceFolders` 多元素场景与按文件定位。
- 需要构造多仓库临时目录 fixture（含/不含 `.git`）。
- 并发测试需可观测的“开始/结束”钩子以统计峰值。

## 实现难度与风险评估

- 实现难度：中高（7.5/10）
  - 原因：跨 `workspaceRoot/FileScanner/ReviewEngine/commands` 多模块联动，且涉及并发调度。
- 变更风险：中高（6.5/10）
  - 原因：需要同时保证单根兼容与多根新增语义，入口较多。
- 回归风险：中高（7/10）
  - 原因：保存自动复审、忽略过滤与命令入口存在共享状态与历史契约。
