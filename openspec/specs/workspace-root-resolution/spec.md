# workspace-root-resolution

统一「有效工作区根」的解析约定与实现，替代各处对 `workspaceFolders?.[0]` 的直接使用；单根时行为与现有一致，为后续多根预留扩展点。

## ADDED Requirements

### Requirement: 有效工作区根由统一入口解析

系统 SHALL 提供统一的「有效工作区根」解析方式，供配置、扫描、审查、忽略、日志等模块使用。解析结果在**单根工作区**下 MUST 与「取 `workspaceFolders[0]`」等价；无工作区时 MUST 返回表示「无根」的约定值（如 `undefined` 或空路径，与现有逻辑一致）。调用方 SHALL 通过该入口获取根，而非直接使用 `workspaceFolders?.[0]`。

#### Scenario: 无工作区文件夹

- **WHEN** `workspaceFolders` 为空或 undefined
- **THEN** 有效根解析结果为无根（与现有「无 folder 时行为」一致，如 config/scan 不落盘、getGitRoot 返回 null 等）

#### Scenario: 单根工作区

- **WHEN** `workspaceFolders` 仅有且仅有一个元素
- **THEN** 有效根解析结果 MUST 等于该唯一 folder 的 `uri.fsPath`（或对应 `WorkspaceFolder`），与当前使用 `[0]` 的行为一致

#### Scenario: 多根工作区（兼容预留）

- **WHEN** `workspaceFolders` 有多个元素
- **THEN** 有效根解析结果 SHALL 有明确约定（本次实现采用与单根一致策略：取第一个 folder），以便调用方行为可预测；后续可扩展为「活动编辑器所在 folder」而不改变本规格的对外行为约定

### Requirement: 调用方使用统一解析结果

ConfigManager、FileScanner、ReviewEngine、extension（getGitRoot 等）、ignoreIssueCommand、runtimeLogPath、reviewEngine.runSummary 等所有当前直接读取 `workspaceFolders?.[0]` 的调用点 SHALL 改为使用上述统一解析入口（或接收由该入口得到的根参数）。MUST 不改变对外 API 与用户可见行为；单根场景下功能与重构前一致。

#### Scenario: 单根回归

- **WHEN** 工作区为单根，用户执行配置加载、staged 审查、忽略、运行日志路径解析等
- **THEN** 行为与重构前一致（配置路径、git 根、忽略存储路径、日志路径等均基于同一根）
- **AND** 现有单根相关单测与集成用例通过，作为回归基线

#### Scenario: 无根不崩溃

- **WHEN** 无工作区文件夹时，任何依赖根的流程被触发
- **THEN** 系统不抛出未处理异常，行为与当前无 folder 时的处理一致（如提前返回、使用 fallback）
