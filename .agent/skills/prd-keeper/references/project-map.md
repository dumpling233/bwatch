# 项目地图

本文件记录当前项目结构，用于路由和 PRD 维护。初始化后需要结合真实代码、配置和用户说明填充。

既有项目接入治理时，本文件可以随后续任务逐步完善；优先补齐本次任务相关的路径、命令、模块和约束。

## 项目

- 项目名称：`bwatch`
- 项目路径：`D:\self-work\bwatch`
- 技术栈：TypeScript、VSCode Extension API、Node.js 测试。
- 业务领域：B站直播间状态监控。

## 已确认结构

- `.agent/skills/prd-keeper/`：项目级 PRD-first 开发 Skill。
- `docs/prd/`：PRD 总入口、产品概览、架构、模块索引、模块文档和独立 PRD 日志。
- `AGENTS.md`、`CODEX.md`、`CLAUDE.md`：AI 入口文件。
- `src/`：VSCode 扩展源码。
- `src/danmakuClient.ts`、`src/danmakuProtocol.ts`、`src/danmakuStatusBar.ts`、`src/danmakuWebviewProvider.ts`、`src/wbiSigner.ts`：实时弹幕机的会话、协议、底部状态栏、View 和签名适配。
- `media/`：VSCode Activity Bar 图标和 Webview 静态资源。
- `package.json`：扩展贡献点、配置项和 npm 脚本。

## 待确认结构

- 部署方式：待确认。
- 发布渠道：待确认。

## 当前 PRD 文件

- `docs/prd/README.md`
- `docs/prd/product-overview.md`
- `docs/prd/architecture.md`
- `docs/prd/modules/README.md`
- `docs/prd/modules/live-monitor.md`
- `docs/prd/modules/prd-keeper.md`
- `docs/prd/prd_log/`
