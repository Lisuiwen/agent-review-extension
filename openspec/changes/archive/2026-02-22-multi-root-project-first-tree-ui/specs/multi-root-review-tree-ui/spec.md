# multi-root-review-tree-ui

定义多根工作区下结果面板的项目优先分层展示契约，使用户先按项目定位，再查看来源、文件与问题。

## ADDED Requirements

### Requirement: 结果面板必须按项目优先分层展示

系统 SHALL 在结果面板中按 `workspaceRoot` 先构建项目节点，并在每个项目节点下按来源与文件继续分层。展示层级 MUST 为：`项目 -> 规则/AI -> 文件 -> 问题`。

#### Scenario: 多根结果按项目分层
- **WHEN** 审查结果包含两个及以上不同 `workspaceRoot` 的问题
- **THEN** 面板顶层节点按项目展示，而非全局“规则/AI”分组
- **AND** 每个项目节点下包含“规则检测错误(N)”与“AI检测错误(N)”来源分组，再到文件与问题节点

#### Scenario: 单根结果兼容
- **WHEN** 审查结果仅包含一个 `workspaceRoot`
- **THEN** 面板仅展示一个项目节点并保持问题内容完整
- **AND** 问题节点的定位、hover、放行与忽略行为与现有语义一致

### Requirement: 项目标签必须目录名优先且重名可区分

系统 SHALL 默认使用项目根目录名（`basename(workspaceRoot)`）作为项目节点标签；当目录名重名时 MUST 自动追加路径后缀以区分不同项目。

#### Scenario: 目录名唯一时展示目录名
- **WHEN** 各项目 `basename(workspaceRoot)` 互不重复
- **THEN** 每个项目节点标签仅显示目录名
- **AND** 不附加额外路径信息

#### Scenario: 目录名重名时追加路径后缀
- **WHEN** 两个及以上项目的目录名相同
- **THEN** 系统为重名项目节点追加路径后缀（如 `project-a (services/a)`）以去重
- **AND** 不同项目节点在视觉上可稳定区分

### Requirement: 缺失归属问题必须可见且可操作

当问题缺失 `workspaceRoot` 时，系统 MUST 以兜底项目节点展示该问题，且问题节点交互能力不得退化。

#### Scenario: 缺失归属进入兜底分组
- **WHEN** 某条问题未携带 `workspaceRoot`
- **THEN** 该问题被归入“未归属项目”节点
- **AND** 系统不因缺失归属字段抛出未处理异常

#### Scenario: 兜底分组问题可定位
- **WHEN** 用户在“未归属项目”节点下选择问题
- **THEN** 系统仍可打开并定位到对应文件行列
- **AND** 放行/忽略命令上下文保持可用

### Requirement: 跨项目同名文件不得串组

系统 MUST 先按项目分桶再按文件分组；同名文件在不同项目中 SHALL 保持隔离展示。

#### Scenario: 同名文件跨项目隔离
- **WHEN** 项目 A 与项目 B 均存在 `src/index.ts` 且均有问题
- **THEN** 两个文件节点分别位于各自项目节点下
- **AND** 不会出现跨项目混合统计或混合问题列表
