## Why

当前多根能力已完成“数据归属与聚合执行”，`ReviewIssue.workspaceRoot` 可正确标记问题所属项目；但结果面板仍按“规则/AI -> 文件 -> 问题”展示，未把项目作为一等信息呈现。多根场景下会出现同名文件、跨项目问题混排，可读性与定位效率明显下降。

为降低多根使用成本，需要把 TreeView 展示升级为“项目优先分层”，先按项目聚合，再看来源与文件，直接匹配用户在多根工作区的认知路径。

## What Changes

- 将结果面板结构从：
  - `规则/AI -> 文件 -> 问题`
- 调整为：
  - `项目(workspaceRoot) -> 规则/AI -> 文件 -> 问题`
- 项目节点按 `ReviewIssue.workspaceRoot` 归属构建；缺失归属的 issue 放入“未归属项目”兜底节点，避免丢失展示。
- 保持现有问题级动作（放行/忽略）与 hover 交互不变，仅调整节点层级与分组统计口径。
- 单根场景继续可用：项目层仅 1 个节点，不改变问题内容与命令行为。

## Capabilities

### New Capabilities

- `multi-root-review-tree-ui`: 多根结果面板支持项目优先分层展示，提升跨项目可读性与定位效率。

### Modified Capabilities

- `multi-root-review-attribution`: 由“数据归属可用于后续展示分组”进一步落地到 TreeView 的实际展示策略。

## Impact

- 受影响代码：
  - `src/ui/reviewPanelProvider.ts`
  - `src/ui/reviewTreeItem.ts`
  - `src/ui/reviewPanel.ts`（仅当需要适配 reveal/缓存键时）
- 行为影响：
  - 根节点不再直接是规则/AI 分组，而是项目节点。
  - 分组统计改为项目内统计，不再是全局规则/AI汇总节点。
- 向后兼容：
  - `ReviewIssue` 数据模型不变。
  - 现有 issue 级命令上下文值保持兼容。
- 测试影响：
  - 需新增/改造 UI 测试覆盖多根分层、单根兼容、跨项目同名文件不串组。
