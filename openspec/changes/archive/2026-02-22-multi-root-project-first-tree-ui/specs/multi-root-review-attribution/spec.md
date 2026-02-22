# multi-root-review-attribution

定义多根工作区下的审查执行与结果归属契约：仅对 Git 项目执行审查，执行可并发聚合，且每条问题都具备所属项目标识，供展示层按项目稳定分组。

## MODIFIED Requirements

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
