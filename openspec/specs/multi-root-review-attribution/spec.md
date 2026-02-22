# multi-root-review-attribution

定义多根工作区下的审查执行与结果归属契约：仅对 Git 项目执行审查，执行可并发聚合，且每条问题都具备所属项目标识，供展示层按项目稳定分组。

## Requirements

### Requirement: 多根工作区审查范围与聚合执行

系统 SHALL 在多根工作区下识别可参与审查的项目集合，并对集合内项目执行聚合审查。默认仅纳入可识别 Git 仓库的 workspace folder；聚合执行 MUST 支持全局共享并发上限控制。

#### Scenario: 仅 Git 项目参与
- **WHEN** 工作区存在多个 folder，且其中仅部分 folder 可识别为 Git 仓库
- **THEN** 系统仅对 Git 项目创建审查任务
- **AND** 非 Git 项目不会进入审查执行链路

#### Scenario: 全局并发池约束
- **WHEN** 多个项目同时具备待审内容，且配置了全局并发上限 N
- **THEN** 系统在任意时刻并发执行的审查任务数 MUST 不超过 N
- **AND** 最终结果包含所有已执行项目的汇总问题

### Requirement: 审查问题必须携带项目归属

系统在多根聚合场景下生成的每条 `ReviewIssue` MUST 包含所属 `workspaceRoot` 标识；该标识 SHALL 与问题来源项目一致，并作为过滤、忽略与项目分层展示的统一归属依据。

#### Scenario: 多根聚合结果归属正确
- **WHEN** 两个或以上项目分别产出审查问题并被聚合
- **THEN** 每条问题的 `workspaceRoot` 等于其来源项目根路径
- **AND** 不同项目的问题归属不会互相混淆

#### Scenario: 单根兼容
- **WHEN** 工作区仅包含一个项目
- **THEN** 审查结果行为与现有单根语义一致
- **AND** 新增归属字段不改变既有调用方可见行为

#### Scenario: 归属字段可被展示层稳定消费
- **WHEN** 展示层按 `workspaceRoot` 对聚合结果分组
- **THEN** 系统可稳定把问题归入其所属项目分组
- **AND** 展示层无需依赖“第一个 workspace folder”推断问题归属

### Requirement: 项目级忽略库按归属隔离

系统 MUST 依据问题归属项目访问对应 ignore store（`<workspaceRoot>/.vscode/agentreview-ignore.json`），不同项目间的忽略规则 SHALL 相互隔离。

#### Scenario: 相同指纹跨项目隔离
- **WHEN** 项目 A 和项目 B 均出现同一指纹的问题，且仅 A 写入 ignore
- **THEN** A 中该问题会被忽略过滤
- **AND** B 中该问题不会被 A 的 ignore 规则过滤
