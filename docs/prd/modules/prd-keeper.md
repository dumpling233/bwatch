# PRD Keeper 治理模块

## 模块范围

PRD Keeper 治理模块由 `.agent/skills/prd-keeper/`、`AGENTS.md`、`CODEX.md`、`CLAUDE.md` 和 `docs/prd/` 组成，用于约束 AI 开发代理在代码变更前后维护 PRD 上下文。

## 当前入口

- 通用 Agent 入口：`AGENTS.md`
- Codex 入口：`CODEX.md`
- Claude 入口：`CLAUDE.md`
- Skill 入口：`.agent/skills/prd-keeper/SKILL.md`
- 路由文件：`.agent/skills/prd-keeper/routing.yaml`
- 日志生成脚本：`.agent/skills/prd-keeper/scripts/new_prd_log.py`
- 校验脚本：`.agent/skills/prd-keeper/scripts/check_prd_keeper.py`
- PRD 总入口：`docs/prd/README.md`
- PRD 日志目录：`docs/prd/prd_log/`
- 新日志命名：`docs/prd/prd_log/YYYYMMDD-{git-user}.md`

## 当前规则

- 每个非平凡任务开始前通过 `$prd-keeper` 读取 `SKILL.md`、`routing.yaml` 和 `docs/prd/README.md`。
- 修改代码前阅读相关 PRD、模块文档、架构文档和最近相关日志。
- 如果相关 PRD 缺失、仍为 `待确认` 或与代码现状不一致，先按渐进式治理接管流程补齐本次任务相关范围的 Baseline PRD。
- 修改代码时结合 PRD 与现有代码判断当前真实行为。
- 修改后如果行为、接口、页面、数据、配置、权限或业务规则变化，必须更新对应 PRD。
- 每个非平凡任务结束后必须创建或追加当前 Git 用户当天的 PRD 日志；`{git-user}` 读取 `git config user.name`，用于避免多人写入同一日志文件。

## 校验

修改 Skill、PRD 结构、入口文件或日志后，运行：

```powershell
python .agent\skills\prd-keeper\scripts\check_prd_keeper.py --log-file docs\prd\prd_log\YYYYMMDD-{git-user}.md
```

## 边界与风险

- `prd-keeper` 不替代真实业务需求确认；无法从代码确认的信息必须标记为待确认。
- 如果入口策略变化，必须同步更新 `routing.yaml`、校验脚本、README 和 PRD。
