# Agent 入口

本项目使用 `prd-keeper` 维护 PRD-first 可审计 AI 研发闭环。处理非平凡开发任务时必须优先阅读 [.agent/skills/prd-keeper/SKILL.md](.agent/skills/prd-keeper/SKILL.md)、[.agent/skills/prd-keeper/routing.yaml](.agent/skills/prd-keeper/routing.yaml) 和 [docs/prd/README.md](docs/prd/README.md)。

如果 `docs/prd/` 仍存在大量 `待确认`、缺少本次任务相关模块文档，或 PRD 与代码现状不一致，不要跳过治理流程；先按 `prd-keeper` 的渐进式治理接管流程补齐本次任务相关范围的 Baseline PRD，再继续实现用户需求。

执行开发时，从 [docs/prd/README.md](docs/prd/README.md) 进入分层 PRD，继续阅读 [docs/prd/modules/README.md](docs/prd/modules/README.md)、相关模块文档、[docs/prd/architecture.md](docs/prd/architecture.md) 与最近相关日志，然后再阅读相关代码。代码修改完成后，如果行为、接口、页面、数据、配置、权限或业务规则变化，必须更新对应 PRD，并在 [docs/prd/prd_log](docs/prd/prd_log) 创建或追加 `YYYYMMDD-{git-user}.md` 格式的日志；`{git-user}` 读取 `git config user.name`。

本文件只作为通用 Agent 薄入口。详细规则以 `.agent/skills/prd-keeper/` 为准。