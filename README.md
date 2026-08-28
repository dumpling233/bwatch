# BWatch

BWatch is a VSCode extension that monitors multiple Bilibili live rooms in the sidebar.

## Features

- Monitor multiple Bilibili live room IDs.
- Show live status, online viewer count, live duration, title, anchor name, and last refresh time.
- Show anchor fans count, guard fleet total, and compact refresh status for each room.
- Query one or two adjacent local history dates with a continuous 24/48-hour trend axis and a midnight boundary marker.
- Export all local history to a versioned static dataset and inspect it through a GitHub Pages history workspace.
- Use an extended high-contrast palette so room and aggregate trend lines remain distinguishable.
- Keep the sidebar controls collapsed by default so the room list stays as the primary panel.
- Preserve sidebar display, sort, filter, trend, and control-panel selections while switching VSCode panels.
- Switch between detailed cards and a compact quote-list style view.
- Show live duration as `HH:MM:SS` and tick it locally every second when the live start time is available.
- Sort and filter rooms by live status, online viewers, guard fleet total, fans, and live duration.
- Add rooms and create groups from compact sidebar icon buttons backed by VSCode native input/quick-pick dialogs; manual refresh and search/add remain together on the right side of the overview panel title bar.
- Show total online viewers, guard fleet members, and live/total room counts in every list group header, aligned with the corresponding room columns.
- Cache long-term online viewer samples locally and expand per-room intraday-style mini trend charts for the latest 1 minute to 6 hours, defaulting to 1 minute.
- Expand overview and historical charts with colored online viewer lines, independently adjustable chart heights, multi-select range/group filters, hover values, descending-online legends, and independently selectable total lines for any built-in or custom-group scope.
- Stretch trend chart timelines with the sidebar width while keeping a minimum readable chart width.
- Add adaptive time and viewer-count axis ticks as aggregate charts become wider or taller, with matching grid lines and overlap-aware spacing.
- Add, remove, refresh, and open rooms from the sidebar; use each room's `弹` button to focus the danmaku view and connect that room immediately.
- Enable or disable automatic refresh.
- Configure refresh interval with a minimum of 15 seconds.
- Optionally show a VSCode notification when a monitored room starts streaming.
- Use an explicit HTTP/HTTPS proxy, or auto-probe common Clash/Mihomo local HTTP ports, when VSCode/Node fetch cannot follow the current network proxy automatically.
- Run `BWatch: Diagnose Network` to test each Bilibili API path and inspect failures in the BWatch output channel.
- Open the independent real-time danmaku view, select a monitored room or enter another room ID, and receive up to 500 recent text messages plus 100 real-time Super Chats in separate tabs. Monitored-room choices show green/red live-state dots and keep live rooms first; the live-monitor `弹` action focuses this view and connects the selected room automatically. A compact room summary reuses the live-monitor snapshot to show the anchor, title, live state, online viewers, locally ticking live duration, guard fleet, and followers without issuing additional Bilibili requests. The connection isolates malformed packets and commands, distinguishes transport health from delayed business messages, tolerates routes that do not answer WebSocket Pong while application frames continue, and reconnects after 45 seconds of complete inbound silence, confirmed stale batches, or conservative evidence that other business commands continue while text danmaku selectively stops. Selective-starvation detection requires a text-message baseline, three consecutive 10-second windows, at least 12 other commands, 30 seconds of text silence, and a 60-second rotation cooldown. Reconnects try one server/proxy route at a time, rotate Bilibili hosts before falling back to another proxy, refresh configuration after authentication or route-cycle failures, cancel obsolete room initialization/handshakes, and ignore late events from older sockets. Same-frame UI updates are batched. Diagnostics are written to the `BWatch` output channel without message content. SC entries show price, duration, sender metadata, and content, and disappear when Bilibili sends a deletion event. The view supports clear, auto-scroll, and per-field display controls; turning off Emoji display replaces each Unicode emoji in place with a readable Chinese label or `U+` code-point marker instead of deleting it. The latest normal danmaku is mirrored in the VSCode status bar, which can be toggled with `Ctrl+Alt+D` on Windows/Linux or `Cmd+Alt+D` on macOS without disconnecting the session.

## Settings

| Setting | Default | Description |
|---|---:|---|
| `bwatch.rooms` | `[]` | Bilibili live room IDs to monitor. |
| `bwatch.autoRefresh.enabled` | `true` | Enable automatic refresh. |
| `bwatch.autoRefresh.intervalSeconds` | `15` | Automatic refresh interval in seconds. Values below 15 are clamped to 15. |
| `bwatch.notifications.liveStart.enabled` | `true` | Show a notification when a room starts streaming. |
| `bwatch.network.proxy.mode` | `auto` | Proxy mode for Bilibili API requests. `auto` uses VSCode `http.proxy`, then `HTTPS_PROXY`/`HTTP_PROXY`, and probes common local HTTP proxy ports when the direct/proxy chain fails; `manual` uses `bwatch.network.proxy.url`; `off` disables proxy. |
| `bwatch.network.proxy.url` | `""` | HTTP/HTTPS proxy URL for manual mode, for example `http://127.0.0.1:7890`. SOCKS proxies are not supported. |

## 单主播直播场次历史分析

历史走势控制面板顶部提供“主播 / 直播场次”二级级联下拉框。第一级选择主播，第二级使用本地长期在线人数文件识别并列出直播场次：在线人数大于 0 的连续区间视为一场，0 结束场次，null 表示采集失败或断线，不强制切断当前场次。

场次下拉项按最近结束时间倒序显示日期、起止时间、00:00:00 时长和峰值在线人数。选择场次会将历史走势图定位到场次前后各 5 分钟；跨午夜时自动使用相邻双日范围，用户仍可继续手动调整日期、时间、图例和合计曲线。清除主播筛选后恢复普通历史查询范围；总览和历史图例顶部均提供“隐藏全部”和“全部显示”操作。

选择主播后，级联控件下方会显示“场次峰值”折线图，按时间正序展示每场直播的最高在线人数。默认显示最近 30 场，可切换最近 10 场或全部；图表高度默认 180px，可在 160–640px 范围内调整并跨面板持久化。悬浮数据点可查看完整起止时间、峰值和时长，提示框会在图内自动上下翻转并限制左右边界，避免被裁切或覆盖其他控制区；点击数据点与场次下拉框使用同一套历史定位逻辑。图表使用与其他走势图一致的 360px 最小宽度并随面板宽度自适应，不增加二级横向滚动条；纵轴从 0 开始并按可用高度生成更密的易读刻度和网格线。

## 远程历史走势页面

在 VSCode 命令面板运行 `BWatch: 导出历史网页数据`。首次运行选择当前 `bwatch` 仓库根目录，后续会直接复用本机路径；如果目录失效，命令会要求重新选择。

导出会把全部长期历史写入 `site/data/v2/`，包括已移出监控列表但仍有历史的房间。数据按日期索引拆分为活跃主播独立文件和闲置主播合并文件，页面根据筛选最多 8 路并发按需读取；原始毫秒时间戳、15 秒采样和 `null` 断线语义均保留。命令只写静态数据，不会执行 `git add`、`commit` 或 `push`。

日常更新流程：

```text
插件采集本地历史
    ↓
运行“导出历史网页数据”
    ↓
检查 site/data 变更
    ↓
手动 git add / commit / push
    ↓
GitHub Actions 自动更新 Pages
```

首次启用时，在 GitHub 仓库的 `Settings > Pages > Build and deployment > Source` 选择 `GitHub Actions`。默认分支推送并且 `Deploy history site to Pages` 工作流成功后，可访问 [BWatch 历史走势](https://dumpling233.github.io/bwatch/)。页面和导出数据是公开的，房间号、主播名、分组、采样时间和在线人数都可被下载。

本地发布前可运行：

```bash
node scripts/validate-history-site.mjs site
```

## Notes

Bilibili live room data is fetched from Bilibili live web APIs. Live online viewer count uses the live online rank `onlineNum`; if that request fails while the room is live, BWatch records a `null` sample so the trend line breaks instead of pretending the value is zero.

The danmaku view uses Bilibili's anonymous web WBI and WebSocket protocol. It does not log in, send messages, or persist received danmaku. Because there is no reliable anonymous history backfill for disconnected intervals, route rotation reduces interruption time but cannot recover messages that Bilibili never re-sends. Run `npm run probe:danmaku -- <room-id>` in a normal network environment to perform a 30-second live-message probe.

While a danmaku connection is active, the `BWatch` output channel writes privacy-safe 10-second diagnostics for raw WebSocket traffic, protocol decoding, parsed message counts, Extension Host-to-Webview delivery, and Webview rendering. The diagnostics include no message text, sender name, or UID. When investigating a visible gap, capture the output from at least 30 seconds before the gap through 30 seconds after it.
