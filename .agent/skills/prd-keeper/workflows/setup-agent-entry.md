# 工作流：设置 Agent 入口

用于创建或修复根目录入口文件。

1. 维护 `AGENTS.md`、`CODEX.md` 与 `CLAUDE.md`。
2. 每个入口都指向 `.agent/skills/prd-keeper/SKILL.md`。
3. 每个入口都指向 `.agent/skills/prd-keeper/routing.yaml`。
4. 每个入口都指向 `docs/prd/README.md`。
5. 入口必须明确要求使用 `$prd-keeper`，并说明核心循环：改前读 PRD，结合代码修改，更新模块文档，记录 `docs/prd/prd_log/YYYYMMDD-{git-user}.md`。
6. 入口内容保持简短，避免复制 Skill 规则。
7. 如果未来增加新工具入口，必须先得到用户明确要求。
8. 入口路径变化时同步更新 `references/project-map.md`。
9. 入口变化时运行 `scripts/check_prd_keeper.py`。
10. 入口变化必须创建独立 PRD 日志。
