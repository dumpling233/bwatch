import * as vscode from 'vscode';
import { BilibiliLiveClient } from './bilibiliClient';
import { BilibiliDanmakuSession } from './danmakuClient';
import { DanmakuStatusBar } from './danmakuStatusBar';
import { DanmakuWebviewProvider } from './danmakuWebviewProvider';
import {
  clampAutoRefreshInterval,
  clampDataRefreshInterval,
  moveRoomGroupToIndex,
  normalizeRoomGroups,
  normalizeRoomIds,
  readMonitorSettings,
  readNetworkProxySettings,
  renameRoomGroup,
  reorderRoomGroups
} from './config';
import { exportHistorySiteData, isBwatchRepositoryRoot } from './historySiteExport';
import { LiveMonitor } from './liveMonitor';
import { createProxyFetch, FetchLike, ResolvedProxy, resolveProxy } from './network';
import { runNetworkDiagnostics, writeNetworkDiagnosticReport } from './networkDiagnostics';
import { OnlineHistoryStore } from './onlineHistoryStore';
import { anchorToSearchResult, roomStatusToSearchResult } from './roomSearch';
import { LiveMonitorWebviewProvider } from './webviewProvider';
import { RoomGroup, RoomSearchResult } from './types';

const CONFIG_SECTION = 'bwatch';
const HISTORY_SITE_EXPORT_ROOT_KEY = 'bwatch.historySiteExportRoot.v1';
const DANMAKU_STATUS_BAR_ENABLED_KEY = 'bwatch.danmakuStatusBar.enabled';
let activeHistoryStore: OnlineHistoryStore | undefined;

export function activate(context: vscode.ExtensionContext): void {
  let networkContext = createNetworkContext();
  const fetchImpl: FetchLike = (input, init) => networkContext.fetch(input, init);
  const client = new BilibiliLiveClient(fetchImpl);
  const output = vscode.window.createOutputChannel('BWatch');
  const danmakuSession = new BilibiliDanmakuSession(fetchImpl, () => networkContext.proxy, {
    log: (message) => output.appendLine(message)
  });
  const danmakuStatusBar = new DanmakuStatusBar(
    danmakuSession,
    vscode.window.createStatusBarItem('bwatch.latestDanmaku', vscode.StatusBarAlignment.Left, 10),
    context.globalState.get<boolean>(DANMAKU_STATUS_BAR_ENABLED_KEY, true)
  );
  const historyStore = new OnlineHistoryStore(context.globalState, context.globalStorageUri.fsPath);
  activeHistoryStore = historyStore;
  const monitor = new LiveMonitor(client, getSettings(), {
    notifyLiveStart(roomId, anchorName, title) {
      const displayName = anchorName || roomId;
      const liveTitle = title && title !== displayName ? `：${title}` : '';
      void vscode.window.showInformationMessage(`BWatch：${displayName} 已开播${liveTitle}`, '打开直播间').then((action) => {
        if (action === '打开直播间') {
          void openRoom(roomId);
        }
      });
    }
  }, historyStore);
  const getKnownRoomNames = () => {
    const names: Record<string, string> = {};
    for (const room of monitor.getSnapshot().rooms) {
      if (room.anchorName) {
        names[room.roomId] = room.anchorName;
      }
    }
    return names;
  };

  const danmakuProvider = new DanmakuWebviewProvider(
    context.extensionUri,
    danmakuSession,
    {
      openRoom: (roomId) => void openRoom(roomId),
      setShowEmoji: (showEmoji) => danmakuStatusBar.setShowEmoji(showEmoji),
      logDiagnostic: (message) => output.appendLine(`[${new Date().toISOString()}] [弹幕] ${message}`)
    },
    monitor.getSnapshot().rooms
  );
  const provider = new LiveMonitorWebviewProvider(
    context.extensionUri,
    {
      refresh: () => void monitor.refresh(),
      showAddRoomPicker: () => void showAddRoomInput(client),
      showCreateGroupInput: () => void showCreateGroupInput(),
      removeRoom,
      openRoom: (roomId) => void openRoom(roomId),
      openDanmaku: (roomId) => void openDanmaku(danmakuProvider, roomId),
      deleteGroup,
      showRenameGroupInput: (groupId) => void showRenameGroupInput(groupId),
      moveGroup,
      moveGroupToIndex,
      setRoomGroups,
      setAutoRefreshEnabled,
      setLiveStartNotificationsEnabled,
      setAutoRefreshInterval,
      setDataRefreshInterval,
      getHistoryDates: () => historyStore.getAvailableDatesAsync(),
      queryHistoryDate: (dates, startMinute, endMinute) =>
        historyStore.queryDateRangeHistoryAsync(dates, startMinute, endMinute, getKnownRoomNames()),
      getRoomSessions: (roomId) => historyStore.getRoomSessionsAsync(roomId)
    },
    monitor.getSnapshot()
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('bwatch.liveMonitor', provider, {
      webviewOptions: { retainContextWhenHidden: false }
    }),
    vscode.window.registerWebviewViewProvider('bwatch.danmaku', danmakuProvider, {
      webviewOptions: { retainContextWhenHidden: false }
    }),
    vscode.commands.registerCommand('bwatch.refresh', () => monitor.refresh()),
    vscode.commands.registerCommand('bwatch.addRoom', () => showAddRoomInput(client)),
    vscode.commands.registerCommand('bwatch.removeRoom', removeRoom),
    vscode.commands.registerCommand('bwatch.openRoom', openRoom),
    vscode.commands.registerCommand('bwatch.exportHistorySiteData', () =>
      exportHistoryForSite(context, historyStore, monitor)),
    vscode.commands.registerCommand('bwatch.diagnoseNetwork', () => diagnoseNetwork(networkContext, output)),
    vscode.commands.registerCommand('bwatch.toggleDanmakuStatusBar', async () => {
      const enabled = !danmakuStatusBar.isEnabled();
      await context.globalState.update(DANMAKU_STATUS_BAR_ENABLED_KEY, enabled);
      danmakuStatusBar.setEnabled(enabled);
      vscode.window.setStatusBarMessage(`BWatch：底部弹幕已${enabled ? '开启' : '关闭'}`, 2000);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const networkChanged =
        event.affectsConfiguration('http.proxy') || event.affectsConfiguration(`${CONFIG_SECTION}.network.proxy`);
      if (networkChanged) {
        networkContext = createNetworkContext();
      }
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        monitor.updateSettings(getSettings());
      } else if (networkChanged) {
        void monitor.refresh();
      }
    }),
    output,
    danmakuProvider,
    danmakuStatusBar,
    provider,
    { dispose: () => monitor.dispose() },
    { dispose: () => danmakuSession.dispose() }
  );

  monitor.onDidChange((snapshot) => {
    provider.update(snapshot);
    danmakuProvider.updateRooms(snapshot.rooms);
  });
  void monitor.refresh();
}

export async function deactivate(): Promise<void> {
  await activeHistoryStore?.flush();
  activeHistoryStore = undefined;
}

function getSettings() {
  return readMonitorSettings(vscode.workspace.getConfiguration(CONFIG_SECTION));
}

function createNetworkContext(): { fetch: FetchLike; proxy: ResolvedProxy } {
  const proxySettings = readNetworkProxySettings(vscode.workspace.getConfiguration(CONFIG_SECTION));
  const vscodeProxyUrl = vscode.workspace.getConfiguration('http').get<string>('proxy', '');
  const proxy = resolveProxy({
    mode: proxySettings.mode,
    manualProxyUrl: proxySettings.url,
    vscodeProxyUrl
  });
  return {
    proxy,
    fetch: createProxyFetch(proxy)
  };
}

async function diagnoseNetwork(
  networkContext: { fetch: FetchLike; proxy: ResolvedProxy },
  output: vscode.OutputChannel
): Promise<void> {
  void vscode.window.showInformationMessage('BWatch：正在诊断 B站接口网络，请稍等...');
  const report = await runNetworkDiagnostics(networkContext.fetch, networkContext.proxy);
  writeNetworkDiagnosticReport(output, report);
  const failedCount = report.results.filter((result) => !result.ok).length;
  if (failedCount === 0) {
    void vscode.window.showInformationMessage('BWatch：网络诊断完成，所有接口可访问');
  } else {
    void vscode.window.showWarningMessage(`BWatch：网络诊断完成，${failedCount} 个接口异常，详情见 BWatch 输出面板`);
  }
}
async function exportHistoryForSite(
  context: vscode.ExtensionContext,
  historyStore: OnlineHistoryStore,
  monitor: LiveMonitor
): Promise<void> {
  const rootPath = await resolveHistorySiteExportRoot(context);
  if (!rootPath) {
    return;
  }

  try {
    const report = exportHistorySiteData(rootPath, historyStore, monitor.getSnapshot());
    const action = await vscode.window.showInformationMessage(
      `BWatch：已导出 ${report.roomCount} 个主播、${report.dateCount} 天、${report.pointCount.toLocaleString()} 个采样点（${formatByteSize(report.byteCount)}，${report.changedFileCount} 个文件有变化）`,
      '更换目录'
    );
    if (action === '更换目录') {
      await context.globalState.update(HISTORY_SITE_EXPORT_ROOT_KEY, undefined);
      await exportHistoryForSite(context, historyStore, monitor);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知导出错误';
    void vscode.window.showErrorMessage(`BWatch：历史网页数据导出失败：${message}`);
  }
}

async function resolveHistorySiteExportRoot(context: vscode.ExtensionContext): Promise<string | null> {
  const storedRoot = context.globalState.get<string>(HISTORY_SITE_EXPORT_ROOT_KEY, '');
  if (isBwatchRepositoryRoot(storedRoot)) {
    return storedRoot;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.find((folder) =>
    isBwatchRepositoryRoot(folder.uri.fsPath)
  );
  const selected = await vscode.window.showOpenDialog({
    title: '选择 bwatch 仓库根目录',
    openLabel: '选择仓库',
    defaultUri: workspaceRoot?.uri,
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false
  });
  const rootPath = selected?.[0]?.fsPath;
  if (!rootPath) {
    return null;
  }
  if (!isBwatchRepositoryRoot(rootPath)) {
    void vscode.window.showErrorMessage('BWatch：所选目录不是包含 site/index.html 的 bwatch 仓库根目录');
    return null;
  }

  await context.globalState.update(HISTORY_SITE_EXPORT_ROOT_KEY, rootPath);
  return rootPath;
}

function formatByteSize(byteCount: number): string {
  if (byteCount < 1024) {
    return `${byteCount} B`;
  }
  if (byteCount < 1024 * 1024) {
    return `${(byteCount / 1024).toFixed(1)} KB`;
  }
  return `${(byteCount / (1024 * 1024)).toFixed(1)} MB`;
}


async function showAddRoomInput(client: BilibiliLiveClient): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: '添加 B站直播间',
    prompt: '输入直播间房间号，或输入主播名搜索',
    placeHolder: '例如 26795 或 羽啾'
  });
  const query = String(input ?? '').trim();
  if (!query) {
    return;
  }

  let results: RoomSearchResult[];
  try {
    results = await searchRooms(client, query);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'B站主播搜索暂时不可用，请稍后再试';
    void vscode.window.showWarningMessage(`BWatch：${message}`);
    return;
  }

  if (results.length === 0) {
    void vscode.window.showInformationMessage(`BWatch：没有找到与“${query}”匹配的直播间`);
    return;
  }

  const selected = await vscode.window.showQuickPick(
    results.map((item) => ({
      label: `${item.isLive ? '$(radio-tower) ' : ''}${item.title}`,
      description: `房间 ${item.roomId}${item.monitored ? ' · 已监控' : ''}`,
      detail: item.monitored ? `${item.detail} · 已在监控列表中` : item.detail,
      roomId: item.roomId,
      monitored: item.monitored
    })),
    {
      title: '选择要加入监控的直播间',
      placeHolder: query,
      matchOnDescription: true,
      matchOnDetail: true
    }
  );

  if (selected && !selected.monitored) {
    await addRoomById(selected.roomId);
  }
}

async function searchRooms(client: BilibiliLiveClient, query: string): Promise<RoomSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const results: RoomSearchResult[] = [];
  const seen = new Set<string>();
  const isRoomIdQuery = /^\d+$/.test(trimmedQuery);
  const monitoredRoomIds = new Set(normalizeRoomIds(vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown[]>('rooms', [])));

  if (isRoomIdQuery) {
    const [room] = await client.fetchRooms([trimmedQuery]);
    const result = room && roomStatusToSearchResult(room, monitoredRoomIds.has(trimmedQuery));
    if (!result) {
      throw new Error(room?.error || '直播间不存在或接口未返回该房间');
    }

    return [result];
  }

  let anchors;
  try {
    anchors = await client.searchLiveAnchors(trimmedQuery);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'B站主播搜索暂时不可用，请稍后再试';
    throw new Error(message);
  }

  for (const anchor of anchors) {
    if (seen.has(anchor.roomId)) {
      continue;
    }

    seen.add(anchor.roomId);
    results.push(anchorToSearchResult(anchor, monitoredRoomIds.has(anchor.roomId)));
  }

  return results;
}

async function addRoomById(roomId?: string): Promise<void> {
  const normalizedRoomId = String(roomId ?? '').trim();
  if (!/^\d+$/.test(normalizedRoomId)) {
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rooms = normalizeRoomIds(config.get<unknown[]>('rooms', []));
  if (rooms.includes(normalizedRoomId)) {
    void vscode.window.showInformationMessage(`BWatch：房间 ${normalizedRoomId} 已在监控列表中`);
    return;
  }

  await config.update('rooms', [...rooms, normalizedRoomId], vscode.ConfigurationTarget.Global);
}

async function showCreateGroupInput(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: '新建自定义分组',
    prompt: '输入自定义分组名称',
    placeHolder: '例如 常看 / 虚拟主播 / 本轮关注',
    validateInput(value) {
      const normalizedName = value.trim();
      if (!normalizedName) {
        return '分组名称不能为空';
      }
      if (normalizedName.length > 24) {
        return '分组名称最多 24 个字符';
      }
      return undefined;
    }
  });

  if (name) {
    await createGroup(name);
  }
}

async function showRenameGroupInput(groupId: string): Promise<void> {
  const normalizedGroupId = String(groupId ?? '').trim();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const groups = readGroups(config);
  const group = groups.find((item) => item.id === normalizedGroupId);
  if (!group) {
    return;
  }

  const name = await vscode.window.showInputBox({
    title: '修改分组名称',
    prompt: `修改分组“${group.name}”的名称`,
    value: group.name,
    valueSelection: [0, group.name.length],
    validateInput(value) {
      const normalizedName = value.trim();
      if (!normalizedName) {
        return '分组名称不能为空';
      }
      if (normalizedName.length > 24) {
        return '分组名称最多 24 个字符';
      }
      if (groups.some((item) => item.id !== normalizedGroupId && item.name === normalizedName)) {
        return `分组“${normalizedName}”已存在`;
      }
      return undefined;
    }
  });

  if (name === undefined) {
    return;
  }

  const renamed = renameRoomGroup(groups, normalizedGroupId, name);
  if (renamed.some((item, index) => item.name !== groups[index]?.name)) {
    await config.update('groups', renamed, vscode.ConfigurationTarget.Global);
  }
}

async function removeRoom(roomId?: string): Promise<void> {
  const normalizedRoomId = String(roomId ?? '').trim();
  if (!normalizedRoomId) {
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rooms = normalizeRoomIds(config.get<unknown[]>('rooms', []));
  await config.update(
    'rooms',
    rooms.filter((item) => item !== normalizedRoomId),
    vscode.ConfigurationTarget.Global
  );
  const groups = readGroups(config, rooms).map((group) => ({
    ...group,
    rooms: group.rooms.filter((item) => item !== normalizedRoomId)
  }));
  await config.update('groups', groups, vscode.ConfigurationTarget.Global);
}

async function openRoom(roomId?: string): Promise<void> {
  const normalizedRoomId = String(roomId ?? '').trim();
  if (!/^\d+$/.test(normalizedRoomId)) {
    return;
  }

  await vscode.env.openExternal(vscode.Uri.parse(`https://live.bilibili.com/${normalizedRoomId}`));
}

async function openDanmaku(provider: DanmakuWebviewProvider, roomId?: string): Promise<void> {
  const normalizedRoomId = String(roomId ?? '').trim();
  if (!/^\d+$/.test(normalizedRoomId)) {
    return;
  }

  provider.connectRoom(normalizedRoomId);
  await vscode.commands.executeCommand('bwatch.danmaku.focus');
}

async function setAutoRefreshEnabled(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('autoRefresh.enabled', enabled, vscode.ConfigurationTarget.Global);
}

async function setLiveStartNotificationsEnabled(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('notifications.liveStart.enabled', enabled, vscode.ConfigurationTarget.Global);
}

async function setAutoRefreshInterval(intervalSeconds: number): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('autoRefresh.intervalSeconds', clampAutoRefreshInterval(intervalSeconds), vscode.ConfigurationTarget.Global);
}

async function setDataRefreshInterval(kind: string, intervalSeconds: number): Promise<void> {
  const settingKeys: Record<string, string> = {
    baseInfoIntervalSeconds: 'dataRefresh.baseInfoIntervalSeconds',
    onlineIntervalSeconds: 'dataRefresh.onlineIntervalSeconds',
    fansIntervalSeconds: 'dataRefresh.fansIntervalSeconds',
    guardIntervalSeconds: 'dataRefresh.guardIntervalSeconds'
  };
  const settingKey = settingKeys[kind];
  if (!settingKey) {
    return;
  }

  const fallback = kind === 'fansIntervalSeconds' ? 300 : kind === 'guardIntervalSeconds' ? 60 : 15;
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(settingKey, clampDataRefreshInterval(intervalSeconds, fallback), vscode.ConfigurationTarget.Global);
}

async function createGroup(name: string): Promise<void> {
  const normalizedName = String(name ?? '').trim();
  if (!normalizedName) {
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const groups = readGroups(config);
  if (groups.some((group) => group.name === normalizedName)) {
    void vscode.window.showInformationMessage(`BWatch：分组“${normalizedName}”已存在`);
    return;
  }

  await config.update(
    'groups',
    [...groups, { id: createGroupId(normalizedName, groups), name: normalizedName, rooms: [] }],
    vscode.ConfigurationTarget.Global
  );
}

async function deleteGroup(groupId: string): Promise<void> {
  const normalizedGroupId = String(groupId ?? '').trim();
  if (!normalizedGroupId) {
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const groups = readGroups(config).filter((group) => group.id !== normalizedGroupId);
  await config.update('groups', groups, vscode.ConfigurationTarget.Global);
}

async function moveGroup(groupId: string, direction: 'up' | 'down'): Promise<void> {
  const normalizedGroupId = String(groupId ?? '').trim();
  if (!normalizedGroupId) {
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const groups = readGroups(config);
  const reordered = reorderRoomGroups(groups, normalizedGroupId, direction === 'up' ? -1 : 1);
  if (reordered.every((group, index) => group.id === groups[index]?.id)) {
    return;
  }

  await config.update('groups', reordered, vscode.ConfigurationTarget.Global);
}

async function moveGroupToIndex(groupId: string, targetIndex: number): Promise<void> {
  const normalizedGroupId = String(groupId ?? '').trim();
  if (!normalizedGroupId) {
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const groups = readGroups(config);
  const reordered = moveRoomGroupToIndex(groups, normalizedGroupId, targetIndex);
  if (reordered.every((group, index) => group.id === groups[index]?.id)) {
    return;
  }

  await config.update('groups', reordered, vscode.ConfigurationTarget.Global);
}

async function setRoomGroups(roomId: string, groupIds: string[]): Promise<void> {
  const normalizedRoomId = String(roomId ?? '').trim();
  if (!/^\d+$/.test(normalizedRoomId)) {
    return;
  }

  const selectedGroupIds = new Set((Array.isArray(groupIds) ? groupIds : []).map((id) => String(id).trim()));
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rooms = normalizeRoomIds(config.get<unknown[]>('rooms', []));
  if (!rooms.includes(normalizedRoomId)) {
    return;
  }

  const groups = readGroups(config, rooms).map((group) => {
    const roomSet = new Set(group.rooms);
    if (selectedGroupIds.has(group.id)) {
      roomSet.add(normalizedRoomId);
    } else {
      roomSet.delete(normalizedRoomId);
    }

    return {
      ...group,
      rooms: rooms.filter((item) => roomSet.has(item))
    };
  });

  await config.update('groups', groups, vscode.ConfigurationTarget.Global);
}

function readGroups(config: vscode.WorkspaceConfiguration, rooms?: readonly string[]): RoomGroup[] {
  return normalizeRoomGroups(
    config.get<unknown[]>('groups', []),
    rooms ?? normalizeRoomIds(config.get<unknown[]>('rooms', []))
  );
}

function createGroupId(name: string, groups: readonly RoomGroup[]): string {
  const existingIds = new Set(groups.map((group) => group.id));
  const base = sanitizeGroupId(name) || 'group';
  let candidate = `${base}-${Date.now().toString(36)}`;
  let index = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${Date.now().toString(36)}-${index}`;
    index += 1;
  }

  return candidate;
}

function sanitizeGroupId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
