import * as vscode from 'vscode';
import { BilibiliLiveClient } from './bilibiliClient';
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
import { LiveMonitor } from './liveMonitor';
import { createProxyFetch, FetchLike, ResolvedProxy, resolveProxy } from './network';
import { runNetworkDiagnostics, writeNetworkDiagnosticReport } from './networkDiagnostics';
import { OnlineHistoryStore } from './onlineHistoryStore';
import { anchorToSearchResult, roomStatusToSearchResult } from './roomSearch';
import { LiveMonitorWebviewProvider } from './webviewProvider';
import { RoomGroup, RoomSearchResult } from './types';

const CONFIG_SECTION = 'bwatch';

export function activate(context: vscode.ExtensionContext): void {
  let networkContext = createNetworkContext();
  const fetchImpl: FetchLike = (input, init) => networkContext.fetch(input, init);
  const client = new BilibiliLiveClient(fetchImpl);
  const output = vscode.window.createOutputChannel('BWatch');
  const historyStore = new OnlineHistoryStore(context.globalState, context.globalStorageUri.fsPath);
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

  const provider = new LiveMonitorWebviewProvider(
    context.extensionUri,
    {
      refresh: () => void monitor.refresh(),
      showAddRoomPicker: () => void showAddRoomInput(client),
      showCreateGroupInput: () => void showCreateGroupInput(),
      removeRoom,
      openRoom: (roomId) => void openRoom(roomId),
      deleteGroup,
      showRenameGroupInput: (groupId) => void showRenameGroupInput(groupId),
      moveGroup,
      moveGroupToIndex,
      setRoomGroups,
      setAutoRefreshEnabled,
      setLiveStartNotificationsEnabled,
      setAutoRefreshInterval,
      setDataRefreshInterval,
      getHistoryDates: () => historyStore.getAvailableDates(),
      queryHistoryDate: (date, startMinute, endMinute) =>
        historyStore.queryDateHistory(date, startMinute, endMinute, getKnownRoomNames())
    },
    monitor.getSnapshot()
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('bwatch.liveMonitor', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('bwatch.refresh', () => monitor.refresh()),
    vscode.commands.registerCommand('bwatch.addRoom', () => showAddRoomInput(client)),
    vscode.commands.registerCommand('bwatch.removeRoom', removeRoom),
    vscode.commands.registerCommand('bwatch.openRoom', openRoom),
    vscode.commands.registerCommand('bwatch.diagnoseNetwork', () => diagnoseNetwork(networkContext, output)),
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
    { dispose: () => monitor.dispose() }
  );

  monitor.onDidChange((snapshot) => provider.update(snapshot));
  void monitor.refresh();
}

export function deactivate(): void {}

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
