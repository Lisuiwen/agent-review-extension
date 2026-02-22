# workspace-root-resolution

统一工作区根解析能力，支持多根枚举与按文件定位，同时保持单根场景行为兼容。

## Requirements

### Requirement: 工作区根解析入口必须支持多根定位

系统 SHALL 提供统一的工作区根解析能力，供配置、扫描、审查、忽略、日志等模块使用。该能力 MUST 同时支持：
- 返回全部 workspace folders（用于多根聚合调度）；
- 基于文件路径定位其所属 workspace folder（用于保存复审、问题归属等场景）；
- 在需要单一“有效根”时提供兼容入口，单根场景 MUST 与历史 `workspaceFolders[0]` 行为一致。

#### Scenario: 无工作区文件夹
- **WHEN** `workspaceFolders` 为空或 undefined
- **THEN** 多根枚举结果为空
- **AND** 单一有效根解析结果为无根（与现有无 folder 行为一致）

#### Scenario: 单根工作区
- **WHEN** `workspaceFolders` 仅有一个元素
- **THEN** 多根枚举结果包含该唯一 folder
- **AND** 单一有效根解析结果等于该 folder（与当前单根行为一致）

#### Scenario: 多根按文件定位
- **WHEN** `workspaceFolders` 包含多个元素，且传入某文件路径
- **THEN** 系统返回该文件所属的 workspace folder
- **AND** 若文件不属于任何 folder，则返回无归属结果

#### Scenario: 多根工作区（兼容预留）
- **WHEN** `workspaceFolders` 有多个元素
- **THEN** 单一有效根解析结果 SHALL 有明确约定（本次实现采用与单根一致策略：取第一个 folder），以便调用方行为可预测；后续可扩展为「活动编辑器所在 folder」而不改变本规格的对外行为约定

### Requirement: 调用方必须通过统一解析能力获取根上下文

ConfigManager、FileScanner、ReviewEngine、extension、ignoreIssueCommand、runtimeLogPath、reviewEngine.runSummary 等调用点 SHALL 通过统一解析能力获取根上下文。需要多根语义的流程 MUST 使用“枚举/定位”能力，而非固定依赖第一个 folder。单根场景下对外行为 MUST 保持不变。

#### Scenario: 多根聚合调度不依赖第一个 folder
- **WHEN** 工作区包含多个 folder 且触发多根审查
- **THEN** 调度流程基于枚举结果构建任务上下文
- **AND** 不会仅因第一个 folder 存在而忽略其他可审查项目

#### Scenario: 单根回归兼容
- **WHEN** 工作区为单根并执行配置加载、扫描、审查、忽略、日志路径解析
- **THEN** 行为与重构前一致
- **AND** 现有单根相关测试继续通过

#### Scenario: 无根时流程不崩溃
- **WHEN** 无工作区文件夹时触发依赖根的流程
- **THEN** 系统不抛出未处理异常
- **AND** 调用方按现有策略提前返回或使用 fallback
