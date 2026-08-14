version: 1
skill: prd-keeper
summary: 以 PRD 为入口的代码变更、需求维护和独立 PRD 日志流程。
sources:
  prd_entry: docs/prd/README.md
  product_overview: docs/prd/product-overview.md
  architecture: docs/prd/architecture.md
  module_index: docs/prd/modules/README.md
  task_log: docs/prd/prd_log/YYYYMMDD-{git-user}.md
always_read:
  - rules/agent-behavior.md
  - rules/prd-governance.md
  - references/project-map.md
routes:
  setup_agent_entry:
    triggers:
      - create CODEX.md
      - create CLAUDE.md
      - create AGENTS.md
      - codex entry
      - claude entry
      - agents entry
      - 创建 Codex 入口
      - 创建 Claude 入口
      - 创建 AGENTS 入口
    read:
      - workflows/setup-agent-entry.md
      - rules/agent-behavior.md
      - docs/prd/README.md
  progressive_adoption:
    triggers:
      - progressive governance adoption
      - baseline PRD
      - backfill PRD
      - adopt existing project
      - 接管既有项目
      - 既有项目治理接入
      - 渐进式治理接管
      - 回填 Baseline PRD
      - PRD 还是待确认
      - PRD 与代码不一致
      - 缺少模块文档
    read:
      - workflows/progressive-adoption.md
      - workflows/profile-project.md
      - rules/agent-behavior.md
      - rules/prd-governance.md
      - docs/prd/README.md
      - docs/prd/product-overview.md
      - docs/prd/architecture.md
      - docs/prd/modules/README.md
  profile_project:
    triggers:
      - initialize PRD
      - understand project from PRD
      - 根据 PRD 理解项目
      - 初始化模块文档
    read:
      - workflows/profile-project.md
      - workflows/progressive-adoption.md
      - docs/prd/README.md
      - docs/prd/product-overview.md
      - docs/prd/architecture.md
      - docs/prd/modules/README.md
  change_managed:
    triggers:
      - implement feature
      - modify behavior
      - fix bug
      - refactor module
      - 修改页面
      - 修改接口
      - 修改数据结构
    read:
      - workflows/change-managed.md
      - workflows/progressive-adoption.md
      - rules/prd-governance.md
      - docs/prd/README.md
      - docs/prd/modules/README.md
      - docs/prd/architecture.md
  maintain_prd:
    triggers:
      - update PRD
      - sync PRD
      - 同步 PRD
      - 更新需求文档
    read:
      - workflows/maintain-prd.md
      - docs/prd/README.md
      - docs/prd/product-overview.md
      - docs/prd/architecture.md
      - docs/prd/modules/README.md
  task_closure:
    triggers:
      - final response
      - record log
      - 记录变更日志
      - 结束任务
    read:
      - workflows/task-closure.md
      - references/gotchas.md
      - docs/prd/prd_log/
shells:
  shared_bootstrap: 先读 .agent/skills/prd-keeper/SKILL.md，再读 .agent/skills/prd-keeper/routing.yaml，然后按任务选择路由。
  entry_files:
    - AGENTS.md
    - CODEX.md
    - CLAUDE.md
