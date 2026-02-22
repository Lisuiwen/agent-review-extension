## Context

当前 `ReviewPanelProvider` 仅支持两级来源分组（`rule`/`ai`）后再按文件分组，核心路径是：
- 根节点创建 `ruleNode`、`aiNode`
- 分组节点下 `buildFileItems(...)`
- 文件节点下渲染问题节点

这套结构在单根可用，但在多根下存在两类痛点：
- 同名文件跨项目聚合后难以区分来源项目；
- 先按来源再按文件不符合“先找项目再看问题”的操作习惯。

同时，数据层已具备前提：
- `ReviewIssue.workspaceRoot` 已注入；
- 多根聚合执行与忽略隔离已稳定。

因此本次只做展示层重构，不改审查结果生成与命令语义。

## Goals / Non-Goals

**Goals:**

- 实现 TreeView 项目优先分层：`项目 -> 规则/AI -> 文件 -> 问题`。
- 保持问题节点行为不变（定位、高亮、hover、放行/忽略）。
- 多根和单根都可读且兼容。
- 对 `workspaceRoot` 缺失问题提供稳定兜底展示。

**Non-Goals:**

- 不改 `ReviewIssue` 字段与归属注入逻辑。
- 不改 run/runStaged 聚合策略与并发策略。
- 不改 ignore 计算与存储策略。
- 不在本次引入新的命令或配置项。

## Decisions

### 1) 节点模型显式类型化

- 决策：扩展 TreeItem 元数据，显式区分 `project/source/file/issue/status` 节点类型，替代当前仅依赖 `groupKey` 与 `filePath` 判别。
- 原因：新增“项目层”后，现有判别条件可读性与可维护性下降，且后续容易误判节点意图。

### 2) 项目节点以 workspaceRoot 分桶

- 决策：所有 issue 先按 `workspaceRoot` 分桶；桶 key 为规范化路径字符串。
- 标签策略：
  - 默认仅显示项目目录名（`basename(workspaceRoot)`）；
  - 仅在目录名重名时追加路径后缀去重（如 `project-a (services/a)`）；
  - 无归属显示“未归属项目”。
- 原因：优先满足“项目可见性”，并处理多项目同名目录的可区分性。

### 3) 项目内保留来源分组（规则/AI）

- 决策：每个项目节点下固定保留 `规则检测错误(N)` 与 `AI检测错误(N)` 两个分组。
- 原因：保持与现有认知连续性，用户仍能快速区分规则引擎与 AI 问题来源。

### 4) 文件分组与问题节点逻辑保持原语义

- 决策：来源分组下继续按文件分组，文件下是问题节点；问题节点 label/tooltip/icon/command/contextValue 维持当前实现。
- 原因：减少回归面，确保命令菜单与交互无需改动。

### 5) 缓存与局部刷新从“来源级”升级为“项目+来源级”

- 决策：若保留局部刷新能力，缓存键需包含项目维度（如 `projectRoot + sourceKey`），避免跨项目 reveal/refresh 命中错误节点。
- 原因：当前缓存仅 `rule/ai`，引入项目层后会冲突。

## Data Flow

```text
ReviewResult
  -> flatten issues (errors/warnings/info)
    -> group by workspaceRoot (project buckets)
      -> within project group by source(rule|ai)
        -> within source group by file
          -> map to issue nodes
```

## Rendering Sketch

```text
project-a
├─ 规则检测错误(2)
│  └─ foo.ts (1,1)
│     ├─ message [rule_x]
│     └─ message [rule_y]
└─ AI检测错误(1)
   └─ bar.ts (1)
      └─ message [ai_review]

project-b
└─ 规则检测错误(1)
   └─ foo.ts (1)
      └─ message [rule_z]
```

## Risks / Trade-offs

- [Risk] 节点层级增加后，展开层级变深，点击次数上升。  
  Mitigation：项目节点默认展开，规则分组可按现有策略（rule 展开、ai 折叠）降低操作成本。

- [Risk] 项目名重名导致视觉混淆。  
  Mitigation：重名时在 label 增加路径后缀（如 `project-a (services/a)`）。

- [Risk] 旧测试大量断言顶层含“规则/AI”节点。  
  Mitigation：更新 UI 测试断言为“先项目后来源”，并保留单根兼容断言。

## Test & Validation

### TDD Strategy

- 结论：本变更建议采用 TDD（Red-Green-Refactor）。
- 原因：
  - 属于 UI 分层重构，回归风险集中在节点结构与计数逻辑，最适合先用失败用例锁定行为。
  - 现有 `reviewPanel.incremental` 测试可直接扩展，具备低成本增量验证条件。
- 执行方式：
  - Red：先新增“项目优先分层”相关失败用例。
  - Green：最小化修改 `ReviewPanelProvider/ReviewTreeItem` 让用例通过。
  - Refactor：整理节点构建与缓存键，不改变已通过行为。

| 场景 | 条件 | 期望 | 断言要点 |
|---|---|---|---|
| 多根按项目优先分层 | 两个 workspaceRoot 均有 issue | 顶层为两个项目节点 | `getChildren()` 顶层节点为项目标签，不直接出现全局规则/AI |
| 项目内来源分组正确 | 同一项目含 rule+ai 问题 | 项目下出现规则/AI 两组且计数准确 | `规则检测错误(N)`、`AI检测错误(N)` |
| 同名文件跨项目不串组 | A/B 都有 `src/index.ts` | 分别挂在各自项目下 | 不出现跨项目混合文件节点 |
| 无归属 issue 兜底 | issue.workspaceRoot 缺失 | 展示到“未归属项目” | 节点存在且问题可点击定位 |
| 单根兼容 | 仅一个项目 | 仍可正常浏览问题树 | 项目节点数量=1，问题内容不变 |

建议测试文件：
- `src/__tests__/ui/reviewPanel.incremental.test.ts`（扩展现有用例）
- 视需要新增 `src/__tests__/ui/reviewPanel.multiRootTree.test.ts`

## Rollout Plan

1. 重构 `ReviewPanelProvider` 节点构建与 `getChildren` 分支判断。
2. 扩展 `ReviewTreeItem` 元数据（节点类型/项目信息）。
3. 调整局部刷新缓存键策略（如保留该能力）。
4. 更新 UI 测试并跑单根+多根回归。
5. 在手工验证中覆盖“多根同名文件”和“无归属兜底”。

## Open Questions

- 无。
