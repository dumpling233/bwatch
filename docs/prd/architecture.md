# 架构说明

## 系统结构

- 前端/UI：VSCode `WebviewViewProvider` 提供 Activity Bar 侧边栏监控面板，静态资源位于 `media/`；Webview View 注册时启用 `retainContextWhenHidden`，前端通过 VSCode Webview `getState` / `setState` 保存纯 UI 控制状态。
- 扩展宿主：TypeScript VSCode 扩展，入口为 `src/extension.ts`，编译输出到 `out/`。
- 数据层：不使用数据库；监控房间号、自定义分组和刷新/提醒配置存储在 VSCode 用户设置中，在线人数历史按房间长期保存到 VSCode 扩展本地存储目录。
- 外部服务：通过 B站直播房间基础信息接口 `xlive/web-room/v1/index/getRoomBaseInfo` 获取房间标题、主播名、开播状态、人气和开播时间；通过 `x/relation/stat?vmid={uid}` 获取主播粉丝数；直播中房间再通过 `xlive/general-interface/v1/rank/getOnlineGoldRank` 获取直播页同款在线观众人数；主播名模糊搜索通过 `x/web-interface/search/type?search_type=live_user` 获取候选直播间，搜索请求携带浏览器兼容请求头、搜索页 URL 编码 `referer` 和访客 cookie；所有 B站请求经过统一网络适配层，可按配置使用 HTTP/HTTPS 代理或自动探测常见 Clash/Mihomo 本地 HTTP 代理端口。
- 部署方式：作为 VSCode 扩展运行，发布渠道待确认。

## 主要目录到产品模块的映射

- `src/extension.ts`：扩展激活、命令注册、配置监听、分组配置更新、VSCode 原生输入/候选列表、通知、外部打开和搜索候选已监控状态标记。
- `src/webviewProvider.ts`：侧边栏 Webview View 的 HTML、图标工具栏消息桥接和状态推送。
- `src/liveMonitor.ts`：直播间轮询、快照管理、开播提醒状态机。
- `src/onlineHistoryStore.ts`：在线人数历史采样、本地长期文件持久化、最近已知主播名元数据保存、旧 `globalState` 历史迁移、近期快照裁剪、历史日期列表和按日期时间段查询。
- `src/bilibiliClient.ts`：B站直播接口请求和响应标准化。
- `src/network.ts`：B站请求代理选择、零外部运行时依赖的 HTTP/HTTPS 代理请求封装、auto 本地代理端口候选、`curl` 兜底和网络错误格式化。
- `src/networkDiagnostics.ts`：命令面板网络诊断，测试各 B站接口并写入 `BWatch` 输出面板。
- `src/config.ts`：VSCode 配置读取、房间号去重、自定义分组标准化、刷新间隔下限校验。
- `src/time.ts`：开播时长和刷新时间格式化。
- `src/test/`：核心逻辑单元测试。
- `media/`：扩展图标、Webview 样式和前端脚本。
- `docs/prd/`：PRD 总入口、产品概览、架构、模块文档和独立 PRD 日志。

## 关键数据流

1. 用户在侧边栏或 VSCode 设置中维护 `bwatch.rooms` 和 `bwatch.groups`。
2. `extension.ts` 读取配置并传入 `LiveMonitor`；分组配置会过滤无效分组、重复分组和非当前监控房间成员。
3. `LiveMonitor` 按配置手动或自动调用 `BilibiliLiveClient.fetchRooms()`。
4. `extension.ts` 初始化统一网络适配层：`auto` 模式先读 VSCode `http.proxy`，再读环境变量 `HTTPS_PROXY`/`HTTP_PROXY`；如果直连或 auto 显式代理在 TUN/fake-ip/TLS 场景下失败，会继续尝试 `http://127.0.0.1:7897`、`http://127.0.0.1:7890`、`http://127.0.0.1:10809` 这类常见 Clash/Mihomo 本地 HTTP 代理端口；`manual` 模式使用 `bwatch.network.proxy.url`；`off` 模式直连。配置变化时重建 fetch 适配器并触发刷新。
5. `BilibiliLiveClient` 使用统一 fetch 适配器，以 `req_biz=web_room_componet` 和重复 `room_ids` 参数请求房间基础信息接口，并根据接口返回的 `uid` 补充主播粉丝数和舰队总人数；对直播中房间使用 `ruid` 与 `roomId` 请求在线榜接口补充 `onlineNum`。
6. `LiveMonitor` 执行开播提醒状态机，触发时将房间号、主播名和直播标题交给扩展通知层；同时把本轮每个房间的在线人数和主播名交给 `OnlineHistoryStore` 追加采样，未开播记为 `0`，在线接口失败或不可用记为 `null`。
7. `OnlineHistoryStore` 从 VSCode 扩展本地存储目录加载按房间拆分的长期历史文件，并迁移旧版本 `globalState` 中的 `bwatch.onlineHistory.v1` 历史；本地历史文件兼容旧数组格式，新写入格式保存 `points` 和最近已知 `anchorName`；删除或移除监控房间不会删除长期历史。
8. `LiveMonitor` 将直播间状态、统一刷新时间和当前监控房间最近 24 小时内的 `onlineHistory` 写入 `MonitorSnapshot`，通知 `LiveMonitorWebviewProvider`。
9. Webview 通过 `postMessage` 接收快照并渲染监控面板；展示模式、主播状态筛选、单主播小图开关和小图时间范围位于不受折叠影响的主列表控制区，折叠控制面板按“排序”“分组”“刷新”“聚合走势”分组；分组管理行使用左右两区布局，名称和房间数相邻位于左侧，拖拽手柄、移动、编辑和删除操作集中在右侧。拖放完成后 Webview 通过 `moveGroupToIndex` 只发送目标分组标识和最终索引，扩展宿主依据当前配置校验并重排 `bwatch.groups`；上下按钮继续通过 `moveGroup` 交换相邻分组。`renameGroup` 请求扩展宿主打开预填当前名称的 VSCode 原生输入框，宿主只更新目标分组的 `name` 并保留稳定 `id`、成员和顺序，配置监听随后同步主列表及总览/历史筛选。主列表按固定 `全部` 分组和自定义分组折叠/展开展示，Webview 按每组当前实际展示房间即时求和在线人数与舰队总人数，并通过与详细/简略主播行对应的 CSS Grid 列显示在分组表头，缺失指标按 `0` 贡献且不写回快照；分组折叠和房间分组编辑器展开状态保存在 Webview 状态中。开启单主播走势时用 SVG 按统一时间窗口绘制每个主播的在线人数迷你走势图；开启总览走势时，Webview 以范围集合维护 `全部`、`开播`、`有数据` 和自定义分组的多选状态，按房间号求各范围成员并集，再按监控列表顺序去重绘制。范围按钮和合计虚拟序列复用同一成员状态格式化逻辑，根据各自实际成员与当前快照显示 `开播人数/范围总人数`。每个内置或自定义分组范围均有独立 `Σ` 操作，Webview 可同时按各范围自己的成员和相同时间戳构造多条合计虚拟序列；合计使用独立 ID、稳定颜色和虚线样式，参与统一纵轴、图例和悬浮读数但不写回历史存储。图例按最后有效在线人数排序时只复制并排序图例视图数据，SVG 继续按原曲线数组绘制；运行时回归测试直接执行真实图例函数并约束排序逻辑不得进入 SVG 构造函数。总览范围集合、已选合计范围集合和图例隐藏集合分别保存在 Webview 状态中且互不清空；删除自定义分组时仅裁剪对应失效范围及合计。走势图 SVG 内部同时绘制轴线、纵轴最大/最小值和横轴起止时间；`ResizeObserver` 按当前容器像素宽度重建 SVG，避免线宽、坐标文字或数字形变；CSS 最小宽度保证窄侧栏下的可读性；直播中且存在开播时间时，Webview 基于 `liveStartTime` 本地每秒更新直播时长显示。
10. Webview 历史面板通过 `loadHistoryDates` 消息请求有本地采样的日期列表，通过 `loadHistoryDate` 消息请求某个本地自然日内指定起止分钟的历史曲线数据；历史面板展开时根据已完成快照的刷新时间按本地时区检测自然日边界，仅在跨日后的首个采样完成时重新请求日期列表，避免随轮询周期重复扫描历史文件，并保留仍有效的当前日期和时间范围选择。扩展宿主从 `OnlineHistoryStore` 读取本地文件并返回 `historyDates` 或 `historyDate`，主播名按当前快照、本地历史元数据、房间号顺序兜底，不触发 B站接口请求，也不写入 `MonitorSnapshot`；历史图以独立范围集合多选全部、所选时间段内存在大于 0 在线人数采样的有数据直播间和每个自定义分组，并按房间号生成成员并集。历史图使用独立的已选合计范围集合，可同时构造多个范围的合计虚拟序列；历史范围集合、合计集合和图例隐藏集合分别持久化且相互独立。总览与历史面板共用单列响应式控制骨架和 `buildOverviewChart()`；面板、图表与图例限制为可用宽度，`ResizeObserver` 根据图表容器实际像素宽度重建 SVG，避免历史图例的最小内容宽度撑大横轴。
11. Webview 中的删除、刷新、打开、分组重命名、分组删除、房间分组归属设置、打开添加直播间输入和打开新建分组输入通过消息回传扩展宿主执行；Webview 本身不渲染输入弹窗，分组重命名和新建分组均使用 VSCode 原生输入框。
12. 用户点击侧边栏添加图标后，扩展宿主打开 VSCode 原生输入框；纯房间号输入先通过 `fetchRooms()` 获取标准化房间状态，主播名输入通过 `searchLiveAnchors()` 获取模糊搜索结果，两条路径再通过 `src/roomSearch.ts` 映射为统一的 `RoomSearchResult` 展示结构，并按当前 `bwatch.rooms` 补充 `monitored` 状态；已监控候选显示 `已监控` 并不会重复写入配置，房间号查询返回未知或错误状态时不生成可添加候选。用户点击新建分组图标后，扩展宿主打开 VSCode 原生输入框创建分组。
13. 用户运行 `BWatch: Diagnose Network` 时，扩展宿主用当前网络适配器依次请求基础信息、在线人数、舰队、粉丝和搜索诊断接口，并把诊断结果写入 `BWatch` 输出面板；诊断不修改监控列表、历史数据或 Webview 状态。

## 权限、配置、环境变量和第三方服务边界

- 权限/鉴权：扩展不要求 B站登录，也不处理用户账号或密钥。
- 配置项：
  - `bwatch.rooms: string[]`
  - `bwatch.groups: { id: string; name: string; rooms: string[] }[]`
  - `bwatch.autoRefresh.enabled: boolean`
  - `bwatch.autoRefresh.intervalSeconds: number`
  - `bwatch.notifications.liveStart.enabled: boolean`
- `bwatch.network.proxy.mode: 'auto' | 'manual' | 'off'`
- `bwatch.network.proxy.url: string`
- 环境变量：当 `bwatch.network.proxy.mode` 为 `auto` 且 VSCode `http.proxy` 为空时，扩展读取 `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` 作为 HTTP/HTTPS 代理地址；当该链路仍失败时继续尝试常见本地 HTTP 代理端口。
- 第三方服务：B站直播房间信息接口和主播搜索接口；失败时需要在 UI 中显示未知/错误状态。主播搜索接口返回 HTTP 412 或错误码 `-412` 时视为可恢复的搜索拦截，UI 提示稍后重试或直接输入直播间房间号。
- 在线人数口径：直播中在线观众人数只使用在线榜接口 `onlineNum`；该接口失败时 `online = null`，基础信息接口 `online` 只作为内部人气字段。
- 网络诊断：`BWatch: Diagnose Network` 只写 VSCode `BWatch` Output Channel，不写本地日志文件；诊断输出会展示代理模式、代理来源、代理地址以及 auto 模式下的本地代理候选；常规错误状态仍展示在侧边栏中，开发验证通过测试输出体现。

## AI 修改代码时需要注意的架构约束

- 非平凡变更前必须读取 `docs/prd/README.md`、`docs/prd/product-overview.md`、`docs/prd/modules/README.md`、`docs/prd/architecture.md`、`.agent/skills/prd-keeper/references/project-map.md`、`.agent/skills/prd-keeper/references/gotchas.md` 和最近相关日志。
- 新增页面、命令、配置项、接口字段、状态流转或第三方服务边界时，必须同步更新本文件和相关模块文档。
- B站接口适配逻辑应与 VSCode API 解耦，确保核心逻辑可以通过 Node 单元测试覆盖。
- 自动刷新间隔不得低于 15 秒；配置和 UI 两侧都需要体现该约束。
