# 工作流：维护 PRD

用于文档优先任务，或代码变更后的 PRD 同步。

1. 判断行为、架构、模块、API、数据、配置、权限或工作流是否变化。
2. 用 `docs/prd/README.md` 维护总入口、目标、角色、主流程、索引和最近日志。
3. 用 `docs/prd/product-overview.md` 维护定位、场景、业务规则、边界和风险。
4. 用 `docs/prd/architecture.md` 维护分层、目录映射、数据流、权限、配置、环境变量和第三方边界。
5. 用 `docs/prd/modules/README.md` 维护模块索引。
6. 用 `docs/prd/modules/*.md` 与 `docs/prd/modules/**/*.md` 维护模块当前行为。
7. 当前行为要简洁、可验证。
8. 如果是在补齐 Baseline PRD，明确区分代码确认、用户确认、推断和未知。
9. 历史过程不要写入模块文档。
10. 推断或未知的信息写为 `待确认`。
11. 删除过期描述，避免追加互相矛盾的说法。
12. 创建或追加当前 Git 用户当天的 PRD 日志文件，文件名使用 `YYYYMMDD-{git-user}.md`，其中 `{git-user}` 读取 `git config user.name`。
13. 运行 PRD Keeper 校验脚本。
14. 最终回复概括 PRD 变化。