# AgentReview

VSCode扩展插件，用于代码提交前的自动化代码审查。

## 功能特性

- 规则引擎：支持自定义业务规则检查
- AI审查：集成公司内部AI服务进行代码审查
- Git Hooks：自动安装pre-commit hook
- VSCode集成：拦截Source Control操作

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 监听模式
npm run watch
```

## 配置

在项目根目录创建 `.agentreview.yaml` 配置文件。
