# 工作流：受控代码变更

用于功能开发、行为修改、缺陷修复、重构、页面变化、API 变化、数据/配置变化和权限变化。

1. 阅读 `SKILL.md` 中的必读文件。
2. 阅读 `docs/prd/README.md`。
3. 阅读 `docs/prd/modules/README.md`。
4. 阅读 `docs/prd/architecture.md`。
5. 阅读 `docs/prd/prd_log/` 中最近的 PRD 日志；如任务涉及明确模块，优先阅读与该模块相关的最近日志。
6. 如果存在相关模块文档，继续阅读模块文档。
7. 修改前检查相关代码。
8. 判断相关 PRD 是否足以描述当前真实行为：如果仍为 `待确认`、缺少模块文档，或与代码现状冲突，先执行 `workflows/progressive-adoption.md`，补齐本次任务相关范围的 Baseline PRD。
9. 总结当前文档行为、代码证据以及用户需求与 PRD 的冲突点。
10. 做满足用户最新需求的最小必要代码修改。
11. 模块行为变化时更新模块 PRD。
12. 全局行为或结构变化时更新产品概览或架构文档。
13. 运行相关验证。
14. 最后执行 `workflows/task-closure.md`。