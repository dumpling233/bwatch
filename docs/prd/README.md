# bwatch PRD 总入口

AI 在进行非平凡代码变更前必须先使用 `$prd-keeper`，阅读本文档，再继续阅读相关模块文档、架构文档和最近相关 PRD 日志。修改代码时必须结合 PRD 与现有代码；修改完成后，如果产品行为或工程约束发生变化，必须更新对应 PRD，并在 `docs/prd/prd_log/YYYYMMDD-{git-user}.md` 创建或追加日志；`{git-user}` 必须读取 `git config user.name`。

## 项目一句话说明

`bwatch` 是一个 VSCode 扩展，在 Activity Bar 侧边栏中以监控盘形式展示多个 B站直播间的开播状态、在线观众人数、已开播时长和最近在线走势，并提供单直播间实时弹幕与 Super Chat（SC）查看、自动刷新、手动刷新和开播提醒。

## 当前产品目标

- 让用户在编码时无需切换浏览器即可监控多个 B站直播间状态。
- 支持通过 VSCode 设置和侧边栏交互维护直播间房间号列表。
- 以不低于 15 秒的刷新间隔自动更新直播间状态，同时保留手动刷新入口。
- 允许用户主动把全部长期历史无损导出到仓库，并通过公开 GitHub Pages 按日期和主播分片加载历史走势。
- 本地长期保存在线人数采样，侧边栏只加载近期绘图窗口用于查看每个主播的迷你走势图和总览走势。
- 在配置允许时，仅对直播间从未开播变为直播中这一状态变化触发一次开播提醒。
- 允许用户在独立弹幕机 View 中选择或输入一个直播间，按需连接并分别查看最近 500 条实时文本弹幕和最近 100 条实时 Super Chat，同时在 VSCode 底部状态栏显示最新一条普通弹幕内容。

## 核心用户/角色

- 产品使用者：需要在 VSCode 中监控多个 B站直播间状态的用户。
- 扩展开发者：维护 TypeScript VSCode 扩展代码、Webview UI、B站接口适配和测试。
- AI 开发代理：通过 `AGENTS.md`、`CODEX.md` 或 `CLAUDE.md` 进入 `$prd-keeper` 工作流，修改代码前必须阅读 PRD，修改后必须更新受影响文档并创建或追加当前 Git 用户当天的 PRD 日志。

## 主流程入口

- 应用入口：VSCode 扩展激活事件 `onView:bwatch.liveMonitor`。
- UI 入口：Activity Bar 容器 `bwatch` 下的直播监控 Webview View `bwatch.liveMonitor` 和实时弹幕 Webview View `bwatch.danmaku`。
- 命令入口：`bwatch.refresh`、`bwatch.addRoom`、`bwatch.removeRoom`、`bwatch.openRoom`、`bwatch.diagnoseNetwork`、`bwatch.toggleDanmakuStatusBar`、`bwatch.exportHistorySiteData`。
- 配置入口：VSCode 设置 `bwatch.rooms`、`bwatch.groups`、`bwatch.autoRefresh.enabled`、`bwatch.autoRefresh.intervalSeconds`、`bwatch.dataRefresh.baseInfoIntervalSeconds`、`bwatch.dataRefresh.onlineIntervalSeconds`、`bwatch.dataRefresh.fansIntervalSeconds`、`bwatch.dataRefresh.guardIntervalSeconds`、`bwatch.notifications.liveStart.enabled`、`bwatch.network.proxy.mode`、`bwatch.network.proxy.url`。
- API 入口：扩展内部通过 B站直播房间批量信息接口拉取直播间状态；实时弹幕机通过房间信息、WBI 导航、`getDanmuInfo` 和 B站直播 WebSocket 弹幕服务器获取消息。

## 模块索引

- [模块索引](modules/README.md)
- [直播监控扩展](modules/live-monitor.md)
- [实时弹幕机](modules/danmaku-viewer.md)
- [远程历史走势页面](modules/history-site.md)
- [PRD Keeper 治理](modules/prd-keeper.md)

## 架构文档

- [架构说明](architecture.md)

## 产品概览

- [产品概览](product-overview.md)

## 最近 PRD 日志

- [20260923-dumpling](prd_log/20260923-dumpling.md)

- [20260909-dumpling](prd_log/20260909-dumpling.md)

- [20260829-dumpling](prd_log/20260829-dumpling.md)

- [20260828-dumpling](prd_log/20260828-dumpling.md)

- [20260827-dumpling](prd_log/20260827-dumpling.md)

- [20260824-dumpling](prd_log/20260824-dumpling.md)

- [20260823-dumpling](prd_log/20260823-dumpling.md)

- [20260822-dumpling](prd_log/20260822-dumpling.md)
- [20260820-dumpling](prd_log/20260820-dumpling.md)
- [20260814-dumpling](prd_log/20260814-dumpling.md)
- [20260813-dumpling](prd_log/20260813-dumpling.md)
- [20260812-dumpling](prd_log/20260812-dumpling.md)

## 待确认

- B站接口长期稳定性、限流策略和字段兼容性需要在后续真实使用中继续观察。
- 扩展发布渠道、图标品牌规范和 marketplace 元信息待确认。
