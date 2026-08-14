# 模块索引

本项目当前以 VSCode 扩展为主体，模块文档聚焦当前真实代码和用户可见行为。

## 当前模块列表

- [直播监控扩展](live-monitor.md)：VSCode 侧边栏、直播间配置、B站接口拉取、自动刷新、开播提醒和外部打开。
- [PRD Keeper 治理](prd-keeper.md)：`.agent/skills/prd-keeper/`、`AGENTS.md`、`CODEX.md`、`CLAUDE.md` 和 `docs/prd/`，定义 AI 开发与 PRD 维护流程。

## 待补充模块

- 发布/打包模块：待确认。
- 端到端扩展宿主测试模块：待确认。

## 模块文档规则

模块文档应聚焦当前行为、业务规则、接口契约、数据字段、权限规则和边界情况，不记录历史过程。历史变更统一写入 `docs/prd/prd_log/YYYYMMDD-{git-user}.md`。
