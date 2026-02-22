## Why

当前插件在多根工作区下仍以 `workspaceFolders[0]` 作为唯一上下文，导致扫描、审查、忽略与结果归属都落在单一项目语义上，无法支撑“多项目并发计算但结果可按项目归属”的需求。现在先补齐数据归属能力，可在不立即改 UI 的前提下，先把多根执行链路与结果模型稳定下来，降低后续分树展示改造风险。

## What Changes

- 新增多根数据归属能力：在审查链路中识别并携带问题所属项目（workspace root）信息。
- 新增多根聚合执行能力：对多根工作区进行统一调度，支持“并发合并计算、结果统一汇总”。
- 明确范围边界：本次仅交付数据层/调度层与结果模型扩展，不改 TreeView 分树展示。
- 明确过滤策略：默认仅纳入可识别 Git 仓库的 workspace folder。
- 兼容性要求：单根工作区行为保持不变，多根能力为向后兼容增强。

## Capabilities

### New Capabilities
- `multi-root-review-attribution`: 定义多根工作区下的审查归属模型与聚合执行约定（项目识别、任务调度、结果归并、单根兼容）。

### Modified Capabilities
- `workspace-root-resolution`: 将“有效工作区根”从单根兼容入口扩展为多根可枚举/可定位能力，支持按文件或任务定位所属 workspace root，而非仅返回第一个 folder。

## Impact

- 受影响模块：`src/utils/workspaceRoot.ts`、`src/utils/fileScanner.ts`、`src/core/reviewEngine.ts`、`src/commands/runReviewCommand.ts`、`src/commands/runStagedReviewCommand.ts`、`src/extension.ts`、`src/types/review.ts`。
- 结果契约影响：`ReviewIssue` 将引入项目归属字段（向后兼容可选），供后续 UI 分树与统计使用。
- 运行行为影响：多根下会出现跨项目聚合执行与汇总结果；单根路径保持现有语义。
- 测试影响：需补充多根归属、聚合并发与单根回归测试用例。
