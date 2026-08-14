# 工作流：任务收尾

每个非平凡代码或 PRD 变更在最终回复前都要执行。

1. 重新阅读用户最新请求。
2. 确认交付内容满足最新请求。
3. 按 `rules/prd-governance.md` 判断是否需要更新 PRD。
4. 最终回复前更新受影响 PRD 或模块文档。
5. 创建或追加当前 Git 用户当天的 PRD 日志文件，不追加到多人共享日期文件。
6. 日志文件名格式为 `docs/prd/prd_log/YYYYMMDD-{git-user}.md`；`{git-user}` 必须读取 `git config user.name`，缺失时回退到 `git config user.email` 或 `unknown`。
7. 日志包含：编写人、需求、影响模块、代码变更、PRD 更新、验证、风险/后续事项。
8. 如果本次执行了 Baseline PRD 回填，日志必须说明回填范围、证据来源和仍待确认事项。
9. 运行与变更匹配的验证。
10. Skill 或 PRD 结构变化时运行 `python .agent/skills/prd-keeper/scripts/check_prd_keeper.py --log-file docs/prd/prd_log/YYYYMMDD-{git-user}.md`。
11. 出现可复用坑点时，补充到 `references/gotchas.md`。
12. 不把一次性会话过程写入可复用知识。
13. 最终回复必须说明代码变化。
14. 最终回复必须说明 PRD 更新状态。
15. 最终回复必须说明日志状态、验证和风险。
16. 如果本次执行了 Baseline PRD 回填，最终回复必须说明回填范围、证据来源和仍待确认事项。