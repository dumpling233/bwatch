---
name: prd-keeper
description: "治理 AI 开发中的 PRD 上下文。Use when implementing features, modifying behavior, fixing bugs, refactoring modules, changing UI/API/data/config/permissions, updating requirements, syncing PRD, recording PRD logs, progressively adopting an existing project, backfilling Baseline PRD, or prompts such as '改代码前先读 PRD', '根据 PRD 理解项目', '同步 PRD', '记录变更日志'."
---

# PRD Keeper

`prd-keeper` 用于维护本项目的 PRD-first 可审计 AI 研发闭环：修改前先读 PRD，修改中结合 PRD 与代码，修改后更新模块文档并记录 `docs/prd/prd_log/YYYYMMDD-{git-user}.md`。日志文件名中的 `{git-user}` 必须来自 `git config user.name`，避免不同人员写入同一个日志文件。

## Always Read

- `rules/agent-behavior.md`
- `rules/prd-governance.md`
- `references/project-map.md`

## Common Tasks

- **创建或修复入口文件**：读取 `workflows/setup-agent-entry.md`；维护 `AGENTS.md`、`CODEX.md` 与 `CLAUDE.md`，并指向本 Skill 与 `docs/prd/README.md`。
- **既有项目渐进式治理接管 / Baseline PRD 回填**：读取 `workflows/progressive-adoption.md`；当 PRD 存在大量 `待确认`、缺少相关模块文档，或 PRD 与代码现状不一致时，先补齐本次任务相关范围的当前真实行为。
- **梳理或初始化项目上下文**：读取 `workflows/profile-project.md`，更新 `docs/prd/README.md`、`docs/prd/product-overview.md`、`docs/prd/architecture.md`、`docs/prd/modules/README.md`。
- **实现功能、修改行为、修复缺陷或重构模块**：读取 `workflows/change-managed.md`，再阅读相关 PRD、模块文档和代码。
- **仅维护 PRD**：读取 `workflows/maintain-prd.md`；当前行为写入 PRD，历史过程写入独立 PRD 日志文件。
- **结束非平凡任务**：读取 `workflows/task-closure.md`；验证、更新日志，并判断是否需要补充 `references/gotchas.md`。
- **发现文档冲突、重复踩坑或历史规则失效**：读取 `references/gotchas.md`，再回到匹配的工作流。
- **Other / 未列任务**：读取 `routing.yaml`，重新核对用户最新需求，选择最接近的路径，不要编造产品事实。

## 路由纪律

- 每个新任务都重新读取本文件和 `routing.yaml`。
- 用户最新明确需求优先；如果它与旧 PRD 冲突，完成修改后同步 PRD。
- PRD 缺失、过期或大量 `待确认` 不代表可以跳过 PRD；应触发渐进式治理接管，先补齐本次任务相关范围的当前真实行为。
- 日志只提供历史背景，当前行为以 PRD 与代码为准。
- `SKILL.md` 保持路由作用；稳定约束放入 `rules/`，流程放入 `workflows/`，项目事实和坑点放入 `references/`。

## 验证

修改 Skill、PRD 结构、入口文件或日志后，运行：

```powershell
python .agent\skills\prd-keeper\scripts\check_prd_keeper.py --log-file docs\prd\prd_log\YYYYMMDD-{git-user}.md
```
