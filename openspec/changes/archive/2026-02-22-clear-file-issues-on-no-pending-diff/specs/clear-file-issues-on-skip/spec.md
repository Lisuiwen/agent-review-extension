# 按跳过原因清除该文件 issue - 需求规格（clear-file-issues-on-skip）

## ADDED Requirements

### Requirement: no_pending_diff 时清除该文件在面板中的 issue

当自动复审门控因「无待审查变更」返回 `no_pending_diff` 时，系统 SHALL 清除**该文件**在复审面板中的全部 issue（从当前 result 中移除该文件对应的 errors/warnings/info），并刷新面板展示。清理 SHALL 按文件粒度进行，SHALL NOT 清空整个 result 或其他文件的 issue。

#### Scenario: 门控返回 no_pending_diff 时消费者调用按文件清除

- **WHEN** 保存触发的门控评估返回 `skip: true` 且 `reason === 'no_pending_diff'`，且目标文件路径为 P
- **THEN** 门控消费者（extension）SHALL 调用复审面板的「按文件清除 issue」接口并传入 P
- **AND** 仅针对该文件 P 进行清理，不改变其他文件的 issue

#### Scenario: 按文件清除后面板仅移除该文件的 issue

- **WHEN** 复审面板当前 result 中包含文件 A 与文件 B 的 issue，且调用「按文件清除 issue」并传入文件 A 的路径
- **THEN** 面板更新后的 result 中 SHALL 不再包含文件 A 的任意 issue（errors/warnings/info）
- **AND** 文件 B 的 issue SHALL 保持不变

### Requirement: 复审面板提供按文件清除 issue 的接口

复审面板 SHALL 提供方法（如 `clearIssuesForFile(filePath: string)`），使调用方能够从当前展示的 result 中移除指定文件的全部 issue 并刷新树视图与徽标。路径比较 SHALL 使用与现有面板逻辑一致的规范化方式（如 `path.normalize`）。

#### Scenario: 无当前 result 时调用不报错

- **WHEN** 当前无 result（getCurrentResult 为 null）时调用 clearIssuesForFile(filePath)
- **THEN** 方法 SHALL 直接返回，不抛错、不更新状态

#### Scenario: 该文件本无 issue 时调用幂等

- **WHEN** 当前 result 中不存在指定文件的任意 issue 时调用 clearIssuesForFile(filePath)
- **THEN** 方法 SHALL 不修改 result，可提前返回；再次 getCurrentResult 与调用前一致
