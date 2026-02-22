## 1. 测试基线与用例落盘

- [x] 1.1 在 `src/__tests__/ui/reviewPanel.incremental.test.ts`（或新增 `src/__tests__/ui/reviewPanel.multiRootTree.test.ts`）补充多根分层相关测试骨架与数据夹具
- [x] 1.2 明确并记录本变更的目标测试命令（优先使用与 UI 相关的最小测试范围，后续回归再扩大）：`npx vitest run src/__tests__/ui/reviewPanel.incremental.test.ts`

## 2. TDD 循环一：项目优先分层（项目 -> 规则/AI -> 文件 -> 问题）

- [x] 2.1 Red：先新增失败用例，断言顶层节点为项目节点，且不再直接出现全局“规则检测错误/AI检测错误”根节点
- [x] 2.2 Red：运行目标测试并确认该用例按预期失败（失败原因应指向“当前仍为规则/AI顶层”）
- [x] 2.3 Green：最小化改造 `src/ui/reviewPanelProvider.ts`，实现项目优先分桶与层级构建
- [x] 2.4 Green：运行目标测试并确认通过后勾选（必须实际执行）

## 3. TDD 循环二：项目标签策略（目录名优先，重名追加路径后缀）

- [x] 3.1 Red：先新增失败用例，覆盖“目录名唯一仅显示 basename”与“目录名重名追加路径后缀（如 `project-a (services/a)`）”
- [x] 3.2 Red：运行目标测试并确认新增用例失败（失败原因应指向标签策略未实现）
- [x] 3.3 Green：最小化实现项目标签生成与重名去重逻辑（默认目录名，重名时加后缀）
- [x] 3.4 Green：运行目标测试并确认通过后勾选（必须实际执行）

## 4. TDD 循环三：跨项目隔离与无归属兜底

- [x] 4.1 Red：先新增失败用例，覆盖“跨项目同名文件不串组”与“缺失 `workspaceRoot` 进入未归属项目节点”
- [x] 4.2 Red：运行目标测试并确认新增用例失败（失败原因应指向分桶/兜底逻辑缺失）
- [x] 4.3 Green：最小化实现跨项目文件隔离与“未归属项目”兜底分组
- [x] 4.4 Green：运行目标测试并确认通过后勾选（必须实际执行）

## 5. 结构收敛与回归验证

- [x] 5.1 Refactor：扩展 `src/ui/reviewTreeItem.ts` 节点元数据（`project/source/file/issue/status`）并整理 `ReviewPanelProvider` 分支判别，保持行为不变
- [x] 5.2 Refactor：按设计调整局部刷新缓存键到“项目+来源”维度（如保留缓存能力）
- [x] 5.3 运行 UI 相关回归测试并确认通过后勾选（必须实际执行）
- [x] 5.4 运行更大范围回归（至少覆盖 `src/__tests__/ui/reviewPanel.incremental.test.ts` 与受影响命令/UI链路）并确认通过后勾选（必须实际执行）
