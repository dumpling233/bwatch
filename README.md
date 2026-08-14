# BWatch

BWatch is a VSCode extension that monitors multiple Bilibili live rooms in the sidebar.

## Features

- Monitor multiple Bilibili live room IDs.
- Show live status, online viewer count, live duration, title, anchor name, and last refresh time.
- Show anchor fans count, guard fleet total, and compact refresh status for each room.
- Keep the sidebar controls collapsed by default so the room list stays as the primary panel.
- Preserve sidebar display, sort, filter, trend, and control-panel selections while switching VSCode panels.
- Switch between detailed cards and a compact quote-list style view.
- Show live duration as `HH:MM:SS` and tick it locally every second when the live start time is available.
- Sort and filter rooms by live status, online viewers, guard fleet total, fans, and live duration.
- Add rooms and create groups from compact sidebar icon buttons backed by VSCode native input/quick-pick dialogs.
- Show total online viewers, guard fleet members, and live/total room counts in every list group header, aligned with the corresponding room columns.
- Cache long-term online viewer samples locally and expand per-room intraday-style mini trend charts for the latest 1 minute to 6 hours, defaulting to 1 minute.
- Expand overview and historical charts with colored online viewer lines, multi-select range/group filters, hover values, descending-online legends, and independently selectable total lines for any built-in or custom-group scope.
- Stretch trend chart timelines with the sidebar width while keeping a minimum readable chart width.
- Add, remove, refresh, and open rooms from the sidebar.
- Enable or disable automatic refresh.
- Configure refresh interval with a minimum of 15 seconds.
- Optionally show a VSCode notification when a monitored room starts streaming.
- Use an explicit HTTP/HTTPS proxy, or auto-probe common Clash/Mihomo local HTTP ports, when VSCode/Node fetch cannot follow the current network proxy automatically.
- Run `BWatch: Diagnose Network` to test each Bilibili API path and inspect failures in the BWatch output channel.

## Settings

| Setting | Default | Description |
|---|---:|---|
| `bwatch.rooms` | `[]` | Bilibili live room IDs to monitor. |
| `bwatch.autoRefresh.enabled` | `true` | Enable automatic refresh. |
| `bwatch.autoRefresh.intervalSeconds` | `15` | Automatic refresh interval in seconds. Values below 15 are clamped to 15. |
| `bwatch.notifications.liveStart.enabled` | `true` | Show a notification when a room starts streaming. |
| `bwatch.network.proxy.mode` | `auto` | Proxy mode for Bilibili API requests. `auto` uses VSCode `http.proxy`, then `HTTPS_PROXY`/`HTTP_PROXY`, and probes common local HTTP proxy ports when the direct/proxy chain fails; `manual` uses `bwatch.network.proxy.url`; `off` disables proxy. |
| `bwatch.network.proxy.url` | `""` | HTTP/HTTPS proxy URL for manual mode, for example `http://127.0.0.1:7890`. SOCKS proxies are not supported. |

## Notes

Bilibili live room data is fetched from Bilibili live web APIs. Live online viewer count uses the live online rank `onlineNum`; if that request fails while the room is live, BWatch records a `null` sample so the trend line breaks instead of pretending the value is zero.
