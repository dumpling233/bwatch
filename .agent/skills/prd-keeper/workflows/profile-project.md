# 工作流：梳理项目上下文

用于初始化、刷新或局部补齐项目上下文。既有项目接入时，优先结合 `workflows/progressive-adoption.md` 使用。

1. 阅读 `docs/prd/README.md`。
2. 阅读 `docs/prd/product-overview.md`。
3. 阅读 `docs/prd/architecture.md`。
4. 阅读 `docs/prd/modules/README.md`。
5. 阅读 `docs/prd/prd_log/` 中最近的 PRD 日志。
6. 检查 README、构建文件、源码目录、配置、测试、CI、脚本和生成物。
7. 将发现分类为代码确认、用户确认、根据代码推断或未知。
8. 只把当前真实行为写入 PRD；未知信息写入 `待确认`。
9. 不根据项目名、目录名或默认模板推断产品事实。
10. 如果存在模块，创建或更新 `docs/prd/modules/<module>.md`；复杂模块可创建目录化 PRD。
11. 模块文档必须同时从 `docs/prd/modules/README.md` 和 `docs/prd/README.md` 链接。
12. 结构路径变化时更新 `references/project-map.md`。
13. 如果本次是为后续代码变更补齐上下文，只补齐受影响范围，避免扩散到无关模块。
14. 创建或追加当前 Git 用户当天的 PRD 日志文件，文件名使用 `YYYYMMDD-{git-user}.md`。