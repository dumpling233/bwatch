# 工作流：既有项目渐进式治理接管

用于项目中途接入 `prd-keeper`、PRD 存在大量 `待确认`、缺少相关模块文档，或 PRD 与代码现状不一致的情况。

## 触发条件

- `docs/prd/` 是模板初始状态，关键内容仍为 `待确认`。
- 本次任务涉及的模块没有对应模块 PRD。
- PRD 描述与当前代码、配置、页面、接口或数据结构不一致。
- 用户要求理解、接管、梳理、补齐或迁移既有项目。
- 进行代码变更前，发现无法从 PRD 判断当前真实行为。

## 执行步骤

1. 先阅读 `SKILL.md`、`routing.yaml`、`rules/agent-behavior.md` 和 `rules/prd-governance.md`。
2. 阅读 `docs/prd/README.md`、`docs/prd/product-overview.md`、`docs/prd/architecture.md`、`docs/prd/modules/README.md` 和最近 PRD 日志。
3. 明确本次任务相关范围，不做无关的全项目大扫除。
4. 阅读与该范围相关的 README、配置、构建脚本、源码目录、路由、接口、页面、数据模型、测试和 CI。
5. 将发现分类为：代码确认、用户确认、根据代码推断、未知。
6. 只把当前真实行为写入 PRD；未知项保留为 `待确认`，不要编造。
7. 根据发现更新 `docs/prd/product-overview.md`、`docs/prd/architecture.md`、`docs/prd/modules/README.md` 和相关模块文档。
8. 如果相关模块文档不存在，创建最小必要模块 PRD，并从 `docs/prd/modules/README.md` 和 `docs/prd/README.md` 链接。
9. 如果仅为后续开发补齐相关范围 Baseline PRD，完成补齐后继续执行原任务。
10. 创建或追加当前 Git 用户当天的 PRD 日志，记录本次补齐的范围、证据来源、仍待确认事项和是否继续执行了代码变更。

## 输出要求

- 不要求一次性理解整个既有项目。
- 优先补齐本次任务相关范围的 Baseline PRD。
- 明确标注哪些内容来自代码证据，哪些来自用户确认，哪些只是推断。
- 不把历史接入过程写进模块当前行为文档；历史过程写入 `docs/prd/prd_log/YYYYMMDD-{git-user}.md`。
- 如果用户只要求功能开发，Baseline 回填应服务于该功能的安全实现，避免扩散到无关模块。