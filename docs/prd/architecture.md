# 架构说明

## 系统结构

- 前端/UI：VSCode `WebviewViewProvider` 在 Activity Bar 提供直播监控和实时弹幕两个独立侧边栏 View，静态资源位于 `media/`；`site/` 提供无构建依赖的浏览器历史走势工作台。Webview 使用 `getState` / `setState`，静态页面使用 `localStorage` 保存纯 UI 控制状态。网页 CSS 通过页面、面板、绘图区、边界、坐标和图表颜色语义变量复刻 VSCode 的中性高对比层级；暗色绘图区独立于面板背景，场次峰值主线使用蓝色，不依赖数据分类颜色。
- 扩展宿主：TypeScript VSCode 扩展，入口为 `src/extension.ts`，编译输出到 `out/`。
- 数据层：不使用数据库；监控房间号、自定义分组和刷新/提醒配置存储在 VSCode 用户设置中，在线人数历史按房间长期保存到 VSCode 扩展本地存储目录；用户主动导出后，公开静态副本按日期索引、活跃房间分片和闲置房间合并文件写入 `site/data/v2/`。
- 外部服务：通过 B站直播房间基础信息接口 `xlive/web-room/v1/index/getRoomBaseInfo` 获取房间标题、主播名、开播状态、人气和开播时间；通过 `x/relation/stat?vmid={uid}` 获取主播粉丝数；直播中房间再通过 `xlive/general-interface/v1/rank/getOnlineGoldRank` 获取直播页同款在线观众人数；主播名模糊搜索通过 `x/web-interface/search/type?search_type=live_user` 获取候选直播间；实时弹幕机通过 `room/v1/Room/get_info`、`x/web-interface/nav` 和带 WBI 签名的 `xlive/web-room/v1/index/getDanmuInfo` 获取真实房间号、签名密钥、token 和 WebSocket 服务器，再连接 B站直播弹幕服务器。HTTP 请求经过统一网络适配层，WebSocket 按相同代理配置尝试 HTTP/HTTPS 代理候选。
- 部署方式：核心产品作为 VSCode 扩展运行；`site/` 由默认分支 push 或手动工作流通过官方 GitHub Pages Actions 发布。

## 主要目录到产品模块的映射

- `src/extension.ts`：扩展激活、命令注册、配置监听、分组配置更新、VSCode 原生输入/候选列表、通知、外部打开和搜索候选已监控状态标记。
- `src/historySiteExport.ts`：版本化历史导出契约、按日原始采样、场次摘要、稳定排序、差异写入和原子更新。
- `src/webviewProvider.ts`：侧边栏 Webview View 的 HTML、主播总览标题栏图标操作消息桥接和状态推送。刷新、搜索添加按钮保留原有 DOM 标识，仅调整所属标题栏。
- `src/liveMonitor.ts`：直播间轮询、快照管理、开播提醒状态机。
- `src/onlineHistoryStore.ts`：在线人数历史采样、本地长期文件持久化、最近已知主播名元数据保存、旧 `globalState` 历史迁移、近期快照裁剪、历史日期列表和按日期时间段查询。
- `src/bilibiliClient.ts`：B站直播接口请求和响应标准化。
- `src/wbiSigner.ts`：WBI 图片密钥混排、参数规范化和 `w_rid` 签名。
- `src/danmakuProtocol.ts`：弹幕二进制包编码/可恢复拆包、zlib/Brotli 递归解压、局部错误收集，以及带原始发送时间的 `DANMU_MSG`、Super Chat 与 SC 删除事件标准化。
- `src/danmakuClient.ts`：单房间弹幕会话、可取消初始化/握手、连接尝试世代隔离、WebSocket 认证、应用心跳、传输层 Ping/Pong 假活检测、业务流延迟检测、服务器优先的单线路轮换、事件循环漂移诊断、普通弹幕/SC 独立队列和自动重连。
- `src/danmakuStatusBar.ts`：订阅弹幕会话事件并维护 VSCode 底部最新弹幕状态栏项，支持独立启用和隐藏而不改变会话状态。
- `src/danmakuWebviewProvider.ts`：实时弹幕独立 View、完整监控房间指标快照同步和扩展宿主消息桥。
- `src/network.ts`：B站请求代理选择、零外部运行时依赖的 HTTP/HTTPS 代理请求封装、auto 本地代理端口候选、`curl` 兜底和网络错误格式化。
- `src/networkDiagnostics.ts`：命令面板网络诊断，测试各 B站接口并写入 `BWatch` 输出面板。
- `src/config.ts`：VSCode 配置读取、房间号去重、自定义分组标准化、刷新间隔下限校验。
- `src/time.ts`：开播时长和刷新时间格式化。
- `src/test/`：核心逻辑单元测试。
- `media/`：扩展图标、Webview 样式和前端脚本。
- `media/danmaku.js`、`media/danmaku.css`：弹幕连接控制、状态栏、当前房间监控指标、普通弹幕/SC 标签与内存列表、清屏和自动滚动界面。
- `site/`：公开静态历史走势工作台、`.nojekyll` 和版本化导出数据。
- `scripts/validate-history-site.mjs`：Pages 发布前的数据结构、排序、索引和时间边界校验。
- `.github/workflows/pages.yml`：默认分支判定、站点校验和 GitHub Pages 发布。
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
9. Webview 通过 `postMessage` 接收快照并渲染监控面板；展示模式、主播状态筛选、单主播小图开关和小图时间范围位于不受折叠影响的主列表控制区，折叠控制面板按“排序”“分组”“刷新”分组。主播总览和历史走势各自使用常驻标题栏与展开/收起按钮，标题栏不随内容折叠，只有对应内容区切换隐藏状态；分组管理行使用左右两区布局，名称和房间数相邻位于左侧，拖拽手柄、移动、编辑和删除操作集中在右侧。详细/简略主播行的“弹”按钮发送 `openDanmaku` 消息，扩展宿主把房间号交给 `DanmakuWebviewProvider.connectRoom()` 并执行 `bwatch.danmaku.focus`，从而切换到弹幕 View 并复用现有单房间会话自动连接。拖放完成后 Webview 通过 `moveGroupToIndex` 只发送目标分组标识和最终索引，扩展宿主依据当前配置校验并重排 `bwatch.groups`；上下按钮继续通过 `moveGroup` 交换相邻分组。`renameGroup` 请求扩展宿主打开预填当前名称的 VSCode 原生输入框，宿主只更新目标分组的 `name` 并保留稳定 `id`、成员和顺序，配置监听随后同步主列表及总览/历史筛选。主列表按固定 `全部` 分组和自定义分组折叠/展开展示，Webview 按每组当前实际展示房间即时求和在线人数与舰队总人数，并通过与详细/简略主播行对应的 CSS Grid 列显示在分组表头，缺失指标按 `0` 贡献且不写回快照；分组折叠和房间分组编辑器展开状态保存在 Webview 状态中。开启单主播走势时用 SVG 按统一时间窗口绘制每个主播的在线人数迷你走势图；开启总览走势时，Webview 以范围集合维护 `全部`、`开播`、`有数据` 和自定义分组的多选状态，按房间号求各范围成员并集，再按监控列表顺序去重绘制。范围按钮和合计虚拟序列复用同一成员状态格式化逻辑，根据各自实际成员与当前快照显示 `开播人数/范围总人数`。每个内置或自定义分组范围均有独立 `Σ` 操作，Webview 可同时按各范围自己的成员和相同时间戳构造多条合计虚拟序列；成员缺少历史采样时按 `0` 参与合计，明确 `null` 失败采样仍保留断线，避免分组新增主播后抹掉已有合计历史；合计使用独立 ID、稳定颜色和虚线样式，参与统一纵轴、图例和悬浮读数但不写回历史存储。图例按最后有效在线人数排序时只复制并排序图例视图数据，SVG 继续按原曲线数组绘制；运行时回归测试直接执行真实图例函数并约束排序逻辑不得进入 SVG 构造函数。总览范围集合、已选合计范围集合、图例隐藏集合和两个聚合图各自的高度分别保存在 Webview 状态中且互不清空；删除自定义分组时仅裁剪对应失效范围及合计。走势图 SVG 内部同时绘制轴线、横纵轴自适应刻度、对应网格线、纵轴范围端点和横轴起止时间；横轴从预设整分钟/整小时步长中按绘图区宽度选取，纵轴按绘图区高度使用 `1/2/5 × 10^n` 步长，刻度间距不足时自动裁剪内部标签。`ResizeObserver` 按当前容器像素宽度重建 SVG，图表高度变化时按新的真实高度重新构造 SVG，避免线宽、坐标文字或数字形变；CSS 最小宽度保证窄侧栏下的可读性；直播中且存在开播时间时，Webview 基于 `liveStartTime` 本地每秒更新直播时长显示。
10. Webview 历史面板通过 `loadHistoryDates` 消息请求有本地采样的日期列表，通过 `loadHistoryDate` 消息请求某个本地自然日内指定起止分钟的历史曲线数据；历史面板展开时根据已完成快照的刷新时间按本地时区检测自然日边界，仅在跨日后的首个采样完成时重新请求日期列表，避免随轮询周期重复扫描历史文件，并保留仍有效的当前日期和时间范围选择。扩展宿主从 `OnlineHistoryStore` 读取本地文件并返回 `historyDates` 或 `historyDate`，主播名按当前快照、本地历史元数据、房间号顺序兜底，不触发 B站接口请求，也不写入 `MonitorSnapshot`；历史结果进入渲染层前会过滤无效房间和采样、按时间戳去重排序，并对异常起止时间做兜底，避免单个损坏缓存导致整块历史面板渲染失败。历史图以独立范围集合多选全部、所选时间段内存在大于 0 在线人数采样的有数据直播间和每个自定义分组，并按房间号生成成员并集。历史图使用独立的已选合计范围集合，可同时构造多个范围的合计虚拟序列；历史范围集合、合计集合和图例隐藏集合分别持久化且相互独立。总览与历史面板共用单列响应式控制骨架和 `buildOverviewChart()`；面板、图表与图例限制为可用宽度，`ResizeObserver` 根据图表容器实际像素宽度重建 SVG，避免历史图例的最小内容宽度撑大横轴。
11. Webview 中的删除、刷新、打开、分组重命名、分组删除、房间分组归属设置、打开添加直播间输入和打开新建分组输入通过消息回传扩展宿主执行；Webview 本身不渲染输入弹窗，分组重命名和新建分组均使用 VSCode 原生输入框。
12. 用户点击侧边栏添加图标后，扩展宿主打开 VSCode 原生输入框；纯房间号输入先通过 `fetchRooms()` 获取标准化房间状态，主播名输入通过 `searchLiveAnchors()` 获取模糊搜索结果，两条路径再通过 `src/roomSearch.ts` 映射为统一的 `RoomSearchResult` 展示结构，并按当前 `bwatch.rooms` 补充 `monitored` 状态；已监控候选显示 `已监控` 并不会重复写入配置，房间号查询返回未知或错误状态时不生成可添加候选。用户点击新建分组图标后，扩展宿主打开 VSCode 原生输入框创建分组。
13. 用户运行 `BWatch: Diagnose Network` 时，扩展宿主用当前网络适配器依次请求基础信息、在线人数、舰队、粉丝和搜索诊断接口，并把诊断结果写入 `BWatch` 输出面板；诊断不修改监控列表、历史数据或 Webview 状态。

## 实时弹幕数据流

1. `extension.ts` 创建 `BilibiliDanmakuSession`、`DanmakuWebviewProvider` 和 `DanmakuStatusBar`；直播监控快照变化时把当前监控房间的主播名、标题、开播状态、在线人数、舰队总人数、粉丝数、开播时间及缓存状态同步给弹幕 View。Provider 将 `status === 'live'` 的候选稳定排列在前并保留开播状态供原生下拉框显示绿/红状态点；Webview 为当前房间渲染紧凑指标栏并按 `liveStartTime` 每秒更新时长。该链路只复用现有 `MonitorSnapshot`，不新增轮询、B站请求或弹幕会话网络状态耦合；非监控房间只显示无监控数据的降级状态。
2. 用户选择或输入房间号并发送 `connect` 消息；会话层关闭旧连接、清空旧弹幕并解析真实房间号。
3. 会话层从 `x/web-interface/nav` 获取 WBI 图片密钥并生成约 12 小时有效的本地缓存；使用 `id`、`type`、`wts` 和 `w_rid` 请求 `getDanmuInfo`，遇到 `-352` 时刷新密钥重试一次。
4. 会话层把当前代理候选与 `host_list` 展开为有序线路，优先在同一代理下轮换 B站服务器。每次重连只等待一条线路并在握手前推进游标，失败后短退避再尝试下一条，避免串行握手超时累加；HTTP/HTTPS 代理由 `https-proxy-agent` 提供 CONNECT Agent。会话级 `AbortController` 取消切房或断开前仍在执行的 HTTP 初始化和 WebSocket 握手，尝试世代号与当前 socket 身份检查阻止旧回调污染新连接。
5. 连接打开后发送匿名认证包；认证成功后每 30 秒发送心跳，心跳响应的人气值进入弹幕状态快照。
6. 业务消息按 16 字节大端包头拆分，版本 `2` 使用 zlib、版本 `3` 使用 Brotli 递归解压；解包返回有效包和局部错误，单个损坏压缩包只跳过自身，损坏包长会扫描后续合法包头恢复同步。解包后的业务命令分别进入独立 `try/catch`，单个损坏 JSON 只跳过自身。标准化后的文本弹幕同时保存 B站原始发送时间和扩展宿主收包时间；文本弹幕和 SC 以不同增量消息推送 Webview，SC 删除事件携带待移除的 B站消息 ID。
7. 扩展宿主和 Webview 各自只保留最近 500 条普通弹幕与 100 条 SC；只有首次加载发送完整消息快照，后续连接/心跳快照省略消息数组。普通弹幕事件通过宿主微任务合并为 `messageBatch`，Webview 以单个 `DocumentFragment` 提交同批 DOM，避免跨进程消息积压和逐条布局/滚动。SC 队列按 B站消息 ID 去重并响应删除事件；Webview 通过独立标签页展示普通弹幕与 SC，标签选择写入 Webview 状态。`DanmakuStatusBar` 仍直接订阅会话事件并即时读取最新普通弹幕，不受 Webview 批量更新影响，也不增加网络请求，SC 不覆盖该状态栏。`bwatch.toggleDanmakuStatusBar` 命令切换状态栏项的独立 `enabled` 状态，并把结果写入扩展 `globalState` 的 `bwatch.danmakuStatusBar.enabled`。禁用时渲染入口始终调用 `hide()`，但会话订阅、连接和消息队列保持不变；启用时按最新快照重新渲染。Webview 使用 `getState` / `setState` 保存显示控制面板、自动滚动和各显示选项。一般元数据选项只重绘 Webview 内存消息；`showEmoji` 通过 `setShowEmoji` 消息同步扩展宿主，使普通弹幕、SC 和底部状态栏在关闭 Emoji 时使用相同的序列识别及文本化规则：优先替换为中文名称，名称未知时使用 Unicode 码位标记。转换只作用于展示层，不修改协议数据、连接或宿主快照，重新开启后继续显示内存中的原始 Emoji。
8. 连接认证后每 10 秒发送 WebSocket Ping，但 Pong 只用于 RTT 和辅助诊断，不作为单周期强制断线条件。会话以认证时间、最后业务帧和最后 Pong 的最大值计算绝对静默时长；连续 45 秒没有任何入站活动才 `terminate()` 当前连接，避免不返回 Pong 的 B站节点、透明代理或 TUN 链路在下一次 30 秒应用心跳前被误断。业务健康独立依据 `sentAt` 与 `receivedAt` 判断：连续两条延迟超过 8 秒，或同帧发送时间跨度超过 5 秒时，即使 Pong/心跳正常也终止退化线路。每个 10 秒诊断窗口还检查选择性弹幕饥饿：只有当前连接已收到过普通弹幕、连续 3 个窗口存在消息包且普通弹幕为 0、累计其他业务命令不少于 12 条并距最后弹幕不少于 30 秒时才终止当前线路；收到新弹幕、候选条件中断或建立新连接会清零窗口证据，选择性饥饿轮换使用 60 秒冷却。下一次连接从有序线路集合的下一组合开始；认证成功不清零连续失败计数，稳定 60 秒或连续 5 条低延迟弹幕后才清零。认证失败立即要求重新获取配置/token，其他失败在至少 3 次且完成一轮当前线路后刷新；HTTP 初始化的临时错误也按同一策略重试，明确无效的房间号停止重试。传输探针漂移超过 5 秒时视为 Extension Host 阻塞，本轮不判断网络超时，并在随后 20 秒抑制消息延迟与选择性饥饿误判；每个探针窗口聚合帧、字节、解包、业务命令、解析结果、错误、命令类型、延迟范围以及饥饿窗口证据。扩展宿主给普通弹幕批次附加递增批次号和发出时间，Webview 聚合交付延迟、DOM 提交耗时、定时器漂移与列表数量后回传输出面板，投递 Promise 返回 `false` 或异常时立即记录。诊断不包含正文、发送者或 UID。主动断开或扩展停用会取消 HTTP 初始化、WebSocket 握手、应用心跳、传输探针、健康、认证和重连定时器。

## 历史跨日查询数据流

- Webview 通过 `loadHistoryDate` 消息发送 `dates: string[]`、`startMinute` 和 `endMinute`；`dates` 长度为 1 或 2，长度为 2 时必须是相邻本地自然日。
- `extension.ts` 将请求交给 `OnlineHistoryStore.queryDateRangeHistory()`，由扩展宿主按第一天 00:00 加上相对分钟计算一次连续时间窗口，并从长期本地历史文件中筛选所有房间数据。
- `HistoryQueryResult` 保留首日 `date` 兼容字段，同时返回 `dates`、`startMs`、`endMs` 和双日时的第二天 00:00 `boundaryMs`；Webview 使用同一时间轴绘制，不在前端拼接两个独立图表。
- 单日横轴和范围标签带日期；双日横轴与悬浮提示使用 `MM/DD HH:mm`，在 `boundaryMs` 处显示第二天 00:00 的虚线分界。
- 总览和历史图共用稳定颜色分配器：房间按监控列表索引取色，合计序列从房间数量之后取色；预设调色板耗尽后使用确定性 HSL 颜色，不循环复用已有颜色。

## 静态历史导出与 Pages 数据流

1. 用户运行 `bwatch.exportHistorySiteData`；扩展从本机 `globalState` 读取上次仓库路径，首次或路径失效时通过目录选择器获取仓库根目录。
2. `historySiteExport.ts` 使用 `OnlineHistoryStore.getAvailableDates()`、`queryDateHistory()` 和 `getRoomSessions()` 读取全部长期历史，不改变本地文件格式或查询行为。
3. 导出器把毫秒时间戳转为相对当天起点偏移；当天有正数采样的房间写入独立 `active/{roomId}.json`，其余房间合并写入 `idle.json`，并生成日期索引和场次文件。引用记录 SHA-256、字节数和点数，内容相同不重写，所有更新先写 `.tmp` 再 rename，Manifest 最后更新。
4. 用户手动提交并推送；Pages 工作流先运行 `scripts/validate-history-site.mjs`，再上传整个 `site/` 并部署。工作流通过仓库默认分支元数据判断是否发布。
5. 浏览器以 `cache: no-store` 读取 Manifest，并行读取所选日期索引，再按筛选、合计和图例显隐使用最多 8 路并发补载房间文件；文件失败重试一次，过期加载由 `AbortController` 取消，缓存键由文件路径和内容版本组成。
6. 浏览器用二分查找截取原始范围；合计、纵轴、峰值和悬浮使用原始点，SVG 路径按像素桶保留首尾、峰谷和断线边界。所有自然日标签使用导出时区，避免浏览器本地时区改变边界。
7. 静态页面只读公开数据。命令不导出 Cookie、Token、代理配置或其他 VSCode 状态，也不执行 Git 命令。

## 刷新数据获取策略

- 一轮刷新首先发起 1 次 `getRoomBaseInfo` 批量请求，通过重复 `room_ids` 参数获取当前监控列表的基础状态。54 个房间不会拆成 54 次基础信息请求。
- 基础信息成功后，客户端按房间补充请求：每个有 UID 的房间 1 次粉丝数请求、1 次舰队总人数请求；每个开播房间额外 1 次在线人数请求。因此 54 个房间、4 个开播时首轮最多约 113 次 HTTP 请求，其中基础信息为 1 次，其余是接口本身不提供批量版本的补充查询。
- 补充请求以 6 个房间为并发上限；单个房间内粉丝和舰队请求并行，单个字段失败不会阻塞其他房间或其他字段。每个请求有独立超时和 AbortSignal，底层适配器未及时响应时客户端仍会在本地超时边界返回。
- 粉丝数缓存 5 分钟，舰队总人数缓存 1 分钟，缓存只存在扩展宿主进程内；缓存有效时跳过对应接口，过期后重新请求。请求失败时沿用上一次成功值，首次失败才使用缺失值。
- 补充字段结果同时携带 `stale` 和最近成功时间；Webview 对“本轮失败但沿用缓存”的粉丝数/舰队数显示黄色，并在原生 tooltip 中显示失败说明和最近成功时间；没有缓存的首次失败仍显示缺失值。
- 在线人数不使用短时缓存，仍然在每轮刷新对当前开播房间请求 `getOnlineGoldRank`，以保证展示和历史采样使用当前轮数据；失败时继续使用 `null`，不回退基础接口人气。
- 基础信息批量请求失败时，客户端优先使用最近一次成功的基础响应生成当前房间状态，同时在状态 `error` 中标记降级原因；没有可用旧响应时才为房间生成未知错误状态。失败请求不会刷新成功缓存时间，因此下一轮仍会重试。
- 刷新整体耗时主要由批量基础信息、补充接口响应速度、代理连接建立和限流共同决定。历史走势读取本地文件，不参与 B站网络请求；主播搜索也只在用户主动搜索时触发。

## 主列表子面板布局

- `room-list-panel` 是主列表及其操作的统一 Webview 子面板，内部按“列表控制 -> 列表配置 -> 刷新摘要 -> 分组详情列表”的顺序组织内容；它与总览、历史走势共用 `subpanel`、`subpanel-titlebar` 和 `subpanel-content` 的标题栏/内容区结构。
- `control-panel-toggle` 从顶部全局工具栏移动到主列表子面板标题栏；它只控制排序、分组和刷新配置区的显示，不会隐藏主列表日常控制或分组详情。
- `room-list-toggle` 负责主列表子面板整体展开/收起，状态通过 Webview `getState`/`setState` 持久化；它只隐藏 `room-list-content`，不会影响列表配置二级折叠状态。
- 主列表子面板与主播总览、历史走势保持同级并统一使用左侧折叠箭头、中间标题、右侧操作区、28px 图标按钮槽位和一致的内边距；后两者继续使用各自常驻标题栏和独立内容区。

## 权限、配置、环境变量和第三方服务边界

- 权限/鉴权：扩展不要求 B站登录，也不处理用户账号或密钥；实时弹幕使用匿名网页端 token 和 WBI 签名，不读取用户 Cookie。
- 配置项：
  - `bwatch.rooms: string[]`
  - `bwatch.groups: { id: string; name: string; rooms: string[] }[]`
  - `bwatch.autoRefresh.enabled: boolean`
  - `bwatch.autoRefresh.intervalSeconds: number`
  - `bwatch.dataRefresh.baseInfoIntervalSeconds: number`
  - `bwatch.dataRefresh.onlineIntervalSeconds: number`
  - `bwatch.dataRefresh.fansIntervalSeconds: number`
  - `bwatch.dataRefresh.guardIntervalSeconds: number`
  - `bwatch.notifications.liveStart.enabled: boolean`
- `bwatch.network.proxy.mode: 'auto' | 'manual' | 'off'`
- `bwatch.network.proxy.url: string`
- 环境变量：当 `bwatch.network.proxy.mode` 为 `auto` 且 VSCode `http.proxy` 为空时，扩展读取 `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` 作为 HTTP/HTTPS 代理地址；当该链路仍失败时继续尝试常见本地 HTTP 代理端口。
- 第三方服务：B站直播房间信息、主播搜索、WBI 导航、弹幕服务器配置和直播 WebSocket 弹幕服务；失败时需要在对应 UI 中显示未知/错误状态。主播搜索接口返回 HTTP 412 或错误码 `-412` 时视为可恢复的搜索拦截；弹幕配置接口返回 `-352` 时刷新 WBI 密钥后重试一次。
- 在线人数口径：直播中在线观众人数只使用在线榜接口 `onlineNum`；该接口失败时 `online = null`，基础信息接口 `online` 只作为内部人气字段。
- 网络诊断：`BWatch: Diagnose Network` 只写 VSCode `BWatch` Output Channel，不写本地日志文件；诊断输出会展示代理模式、代理来源、代理地址以及 auto 模式下的本地代理候选；常规错误状态仍展示在侧边栏中，开发验证通过测试输出体现。
- VSIX 运行时依赖：打包清单必须包含 `ws`、`https-proxy-agent` 及其生产传递依赖；`.vscodeignore` 不得使用 `node_modules/**` 排除全部运行时依赖。

## 刷新配置数据流

- `readMonitorSettings()` 读取总轮询配置和四个 `dataRefresh.*IntervalSeconds` 配置，并将其放入 `MonitorSettings.dataRefresh`。
- `LiveMonitor` 仍按总轮询间隔调用 `refresh()`；`BilibiliLiveClient.fetchRooms()` 接收数据刷新设置，分别判断基础信息、在线人数、粉丝数和舰队人数的缓存是否到期。
- 基础信息通过单次批量接口获取；三类补充数据通过房间级请求获取，并受最多 6 个房间并发限制。在线人数、粉丝数和舰队人数的成功值保存在客户端内存缓存中，失败时返回旧值和 stale 标记。
- Webview 只负责编辑和展示设置，不自行请求 B 站接口；设置变更通过 `setDataRefreshInterval` 消息回到扩展宿主，再由 VSCode 配置监听同步给监控器。
- Webview 选择型按钮通过 `active` 类和 `aria-pressed` 表示统一的开关状态；CSS 以透明边框/实心按钮色区分未选中与选中，不使用悬浮色模拟持久状态。
- 图表组件为 SVG 和占位提示预留稳定高度：单主播走势使用固定小图高度；总览/历史分别使用各自的 Webview 状态高度，加载、空数据、错误和成功状态只替换图表内容并沿用当前高度。

## 单主播场次分析数据流

- OnlineHistoryStore.getRoomSessions(roomId) 直接扫描该房间的全部本地长期采样，不读取或修改监控列表状态，因此房间删除后重新添加仍可恢复历史场次。
- 正数采样创建或延续场次，0 结束场次，null 不切断场次但计入 sampleCount；场次摘要包含起止时间、时长、峰值、总采样点和有效采样点。
- Webview 通过 loadRoomSessions(requestId, roomId) 请求场次，宿主调用历史存储后回传 roomSessions。读取失败仅更新分析面板状态，不影响实时列表和聚合走势。
- 点击场次后，Webview 计算前后各 5 分钟的本地时间范围；跨午夜使用现有双日历史查询，最多限制为两个自然日，并保留历史图既有手动筛选、图例和合计状态。

## AI 修改代码时需要注意的架构约束

- 非平凡变更前必须读取 `docs/prd/README.md`、`docs/prd/product-overview.md`、`docs/prd/modules/README.md`、`docs/prd/architecture.md`、`.agent/skills/prd-keeper/references/project-map.md`、`.agent/skills/prd-keeper/references/gotchas.md` 和最近相关日志。
- 新增页面、命令、配置项、接口字段、状态流转或第三方服务边界时，必须同步更新本文件和相关模块文档。
- B站接口适配逻辑应与 VSCode API 解耦，确保核心逻辑可以通过 Node 单元测试覆盖。
- 弹幕二进制协议、WBI 签名和消息标准化必须与 VSCode API 解耦；协议解析不得让单个未知、损坏业务消息或损坏压缩子包终止长连接，也不得丢弃同一帧其他可恢复命令。业务延迟判断必须与 Ping/Pong 传输健康分离，并排除 Extension Host 明显事件循环漂移造成的误判。
- 自动刷新间隔不得低于 15 秒；配置和 UI 两侧都需要体现该约束。

### 单主播场次筛选

历史走势的主播场次分析不再使用独立 Webview 子面板。Webview 在历史走势控制区生成两个级联原生 select 控件：主播选择框使用当前监控快照，场次选择框通过既有 loadRoomSessions 消息读取 OnlineHistoryStore.getRoomSessions(roomId) 的本地长期数据。选择主播时清空旧场次并重新加载；选择场次时复用现有历史查询消息，自动定位到场次前后各 5 分钟，跨午夜最多查询两个相邻自然日。分析房间和场次键继续使用 Webview getState/setState 持久化，清除筛选只恢复普通历史范围，不删除本地历史。

级联控件下方的场次峰值图复用同一批 `LiveSessionSummary` 数据，不触发额外 `loadRoomSessions`、B站请求或本地历史扫描。Webview 将场次按 `startMs` 正序后截取最近 10/30 场或保留全部，以等距 SVG 点位绘制 `peakOnline`；纵轴固定从 0 开始，按绘图区高度设置 4–10 个目标区间并使用易读整数步长，最小刻度间距为 24px。图表使用与其他走势图一致的 360px 最小宽度并随面板宽度自适应，不增加二级横向滚动条；坐标标签使用独立安全边距。场次峰值高度 `sessionPeakHeight` 默认 180px，限制在 160–640px，并与范围状态 `sessionPeakRange` 一起保存在 Webview state。悬浮详情先测量 `offsetWidth/offsetHeight`，优先置于数据点上方，空间不足时置于下方，再把最终坐标夹取到图表边界内，因此图表继续使用 `overflow: hidden` 而不会裁切提示。点选数据点直接调用现有 `selectRoomSession`。

场次时段分类是展示层对 `startMs/endMs/durationMs` 的纯派生计算，不进入 `LiveSessionSummary`、宿主消息、导出 schema 或本地历史格式。短于 4 小时的场次按自然日拆分，累计与八个半开时段区间的重叠毫秒数；最长重叠并列时采用直播中点所属区间，恰在边界时落入后一时段。4 小时及以上场次直接归为长场次。VSCode Webview 使用本机时区并把 `sessionPeakPeriodColorEnabled` 存入 Webview state；GitHub Pages 使用 `manifest.timeZone` 将时间戳转换为导出时区的墙上时间，并把同名状态存入 `localStorage`，保证不同地区访问时分类一致。两端均默认关闭该开关；启用时只修改 SVG 数据点填充和分类图例，折线路径仍使用现有蓝色样式。
### 图例批量显示控制

总览走势图和历史走势图分别将图例隐藏状态传入同一套渲染器，并在图例顶部提供隐藏全部、全部显示操作；批量操作只修改对应图表的隐藏集合，不修改范围筛选、合计曲线配置或本地历史数据。


## 性能与可靠性分层

- 采集层、内存投影、持久化层和 Webview 投递层相互解耦。采集结果先进入内存历史，再异步进入每房间串行 WAL 队列；视图只接收带 revision 的最新投影。
- 在线历史目录同时兼容旧 JSON 文件和新版本 WAL。WAL 记录按 sequence 去重、校验和恢复，批量追加后调用 FileHandle.sync；checkpoint 使用临时文件、同步和原子替换，旧 WAL 在 checkpoint 成功后清理。
- 磁盘后端的实时内存投影超过 12,000 点后裁剪为近期窗口；长期房间查询、场次分析、日期列表和导出通过 JSON/WAL 按需读穿恢复完整点集，compaction 使用完整读穿结果，避免以内存裁剪覆盖旧数据。Webview 的历史日期、范围和场次请求通过异步文件读取 API 完成，并以固定并发上限读取房间文件；Provider 等待结果后回传，采集调度不被同步磁盘 IO 阻塞；同步 API 仍供静态导出兼容使用。
- WAL 启动恢复会对最后一个无效/半写记录执行尾部截断；旧 globalState 迁移的 checkpoint 写入失败只将存储标记为 degraded，不阻塞采集链路。客户端请求层可通过 `BilibiliLiveClientOptions.onRequest` 接收不含正文的请求耗时、状态和失败指标，默认不产生输出副作用。
- OnlineHistoryStore.ready、flush() 和 getPersistenceStatus() 构成生命周期契约：初始化、正常停用和写盘故障均可被调用方观察，单房间失败不阻塞其他房间采集。
- 旧 globalState 迁移只有在所有 checkpoint/存储更新成功后才写入迁移完成标记；失败时保留待迁移状态，下一次启动继续尝试，避免迁移数据只存在于易失内存。
- 多房间 `flush()` 使用 all-settled 语义等待所有房间写入任务结束，再返回首个错误；只有所有待写队列排空后才清除 failed/degraded 状态，修复磁盘后可以继续重试。
- 监控刷新采用完成后调度和配置 revision 校验；慢请求、隐藏视图和 Webview DOM 渲染均不能改变计划采样数量。VSCode Webview provider 在隐藏状态只保留最新快照，可见时重新握手。
- 监控 Webview 使用带 `revision/baseRevision` 的 full/patch 快照信封。宿主只基于最近一次成功投递的快照生成 patch；Webview 发现 revision 缺口后重新发送 `ready`，宿主清除发送基线并发送有界完整快照。patch 失配、投递失败和可见性恢复均不会回写采集或持久化状态。
- 趋势图绘制层以绘图区宽度限制每个连续数值段的 SVG 点数，桶内保留最小值和最大值并维持时间顺序；`null` 样本仍作为断线分隔。该优化位于 Webview 绘制边界，不改变 `MonitorSnapshot.onlineHistory`、WAL 或历史查询结果。
- 房间列表渲染维护布局签名和房间节点键；布局未变化时对已有节点做字段级更新，并单独刷新当前趋势图。列表分组表头的在线、舰队和开播计数与房间字段更新使用同一快照，避免全量 DOM 重建造成布局和事件监听器 churn。
- 第一阶段不引入 React/Lit、SQLite、原生依赖或 Worker；弹幕压缩/JSON 解析是否迁移 Worker 由后续 profiling 决定。
