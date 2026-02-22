# 工作区根解析兼容性重构

## Why

插件当前在配置、扫描、审查、忽略、日志等模块中统一使用 `workspaceFolders?.[0]` 写死「第一个工作区根」，不利于后续多根工作区支持，且多根打开时行为不明确。本次仅做**兼容性重构**：引入统一的「有效工作区根」解析方式，单根时行为与现有一致，为日后多根预留扩展点；**不交付多根功能**。重点通过现有与补充的单根用例**验证回归**，确保重构后单根场景零行为变化。

## What Changes

- 引入统一的「有效工作区根」解析约定与实现（如基于当前活动编辑器所在文件夹，或单根时等价于 `workspaceFolders?.[0]`）。
- 将所有直接使用 `workspaceFolders?.[0]` 的调用改为通过该解析方式获取根（或显式传入根参数），不改变对外行为与 API。
- 不新增多根 UI、不按根分 result、不改变用户可见能力；单根场景必须与当前行为一致。
- 测试：保持并运行现有单根相关用例作为回归基线；必要时补充「有效根解析」的单元测试及单根集成验证。

## Capabilities

### New Capabilities

- **workspace-root-resolution**：定义并实现「有效工作区根」的解析约定与调用方式（单根 = 第一个 folder；后续可扩展为活动编辑器所在 folder），供 ConfigManager、FileScanner、ReviewEngine、extension、ignoreIssue、runtimeLogPath、runSummary 等使用，为多根兼容做准备。对外行为不变，仅实现路径重构。

### Modified Capabilities

- 无。现有规格（如 ast-slice-optimization）无需求变更，仅实现细节调整。

## Impact

- **受影响代码**：所有读取 `workspaceFolders?.[0]` 的模块（ConfigManager、FileScanner、ReviewEngine、extension.ts、ignoreIssueCommand、runtimeLogPath、reviewEngine.runSummary 等）。
- **无对外 API 或配置变更**；单根用户无感知。
- **回归风险**：中；通过「单根等价于 [0]」的明确约定与完整单根测试通过作为验收条件，确保重构后回归问题可验证。
