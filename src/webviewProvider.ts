import * as vscode from 'vscode';
import { formatUpdatedAt } from './time';
import { DataRefreshSettings, HistoryDateSummary, HistoryQueryResult, LiveSessionSummary, MonitorSnapshot } from './types';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openAddRoomPicker' }
  | { type: 'openCreateGroupInput' }
  | { type: 'removeRoom'; roomId: string }
  | { type: 'openRoom'; roomId: string }
  | { type: 'openDanmaku'; roomId: string }
  | { type: 'deleteGroup'; groupId: string }
  | { type: 'renameGroup'; groupId: string }
  | { type: 'moveGroup'; groupId: string; direction: 'up' | 'down' }
  | { type: 'moveGroupToIndex'; groupId: string; targetIndex: number }
  | { type: 'setRoomGroups'; roomId: string; groupIds: string[] }
  | { type: 'toggleAutoRefresh'; enabled: boolean }
  | { type: 'toggleLiveStartNotifications'; enabled: boolean }
  | { type: 'setInterval'; intervalSeconds: number }
  | { type: 'setDataRefreshInterval'; kind: keyof DataRefreshSettings; intervalSeconds: number }
  | { type: 'loadHistoryDates'; requestId: number }
  | { type: 'loadHistoryDate'; requestId: number; dates: string[]; startMinute: number; endMinute: number }
  | { type: 'loadRoomSessions'; requestId: number; roomId: string };

export interface WebviewActions {
  refresh(): void;
  showAddRoomPicker(): void;
  showCreateGroupInput(): void;
  removeRoom(roomId: string): void;
  openRoom(roomId: string): void;
  openDanmaku(roomId: string): void;
  deleteGroup(groupId: string): void;
  showRenameGroupInput(groupId: string): void;
  moveGroup(groupId: string, direction: 'up' | 'down'): void;
  moveGroupToIndex(groupId: string, targetIndex: number): void;
  setRoomGroups(roomId: string, groupIds: string[]): void;
  setAutoRefreshEnabled(enabled: boolean): void;
  setLiveStartNotificationsEnabled(enabled: boolean): void;
  setAutoRefreshInterval(intervalSeconds: number): void;
  setDataRefreshInterval(kind: keyof DataRefreshSettings, intervalSeconds: number): void;
  getHistoryDates(): HistoryDateSummary[];
  queryHistoryDate(dates: string[], startMinute: number, endMinute: number): HistoryQueryResult;
  getRoomSessions(roomId: string): LiveSessionSummary[];
}

export class LiveMonitorWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private viewDisposables: vscode.Disposable[] = [];
  private latestSnapshot: MonitorSnapshot;
  private visible = false;
  private lastSentRevision = -1;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: WebviewActions,
    initialSnapshot: MonitorSnapshot
  ) {
    this.latestSnapshot = initialSnapshot;
  }

  dispose(): void {
    this.viewDisposables.splice(0).forEach((disposable) => disposable.dispose());
    this.view = undefined;
    this.visible = false;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.viewDisposables.splice(0).forEach((disposable) => disposable.dispose());
    this.view = webviewView;
    this.visible = webviewView.visible;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    this.viewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        this.visible = webviewView.visible;
        if (this.visible) {
          this.lastSentRevision = -1;
          this.postLatestSnapshot();
        }
      }),
      webviewView.onDidDispose(() => {
        this.visible = false;
        this.view = undefined;
        this.viewDisposables.splice(0).forEach((disposable) => disposable.dispose());
      }),
      webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.handleMessage(message).catch(() => undefined);
      })
    );
    this.postLatestSnapshot();
  }

  update(snapshot: MonitorSnapshot): void {
    this.latestSnapshot = snapshot;
    if (!this.visible || !this.view) {
      return;
    }
    this.postLatestSnapshot();
  }

  private postLatestSnapshot(): void {
    const revision = this.latestSnapshot.revision ?? 0;
    if (revision === this.lastSentRevision) {
      return;
    }
    this.lastSentRevision = revision;
    this.postMessage({
      type: 'snapshot',
      snapshot: serializeSnapshot(this.latestSnapshot)
    });
  }

  private postMessage(message: unknown): void {
    if (!this.visible || !this.view) {
      return;
    }
    void this.view.webview.postMessage(message).then(undefined, () => undefined);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.lastSentRevision = -1;
        this.postLatestSnapshot();
        break;
      case 'refresh':
        this.actions.refresh();
        break;
      case 'openAddRoomPicker':
        this.actions.showAddRoomPicker();
        break;
      case 'openCreateGroupInput':
        this.actions.showCreateGroupInput();
        break;
      case 'removeRoom':
        this.actions.removeRoom(message.roomId);
        break;
      case 'openRoom':
        this.actions.openRoom(message.roomId);
        break;
      case 'openDanmaku':
        this.actions.openDanmaku(message.roomId);
        break;
      case 'deleteGroup':
        this.actions.deleteGroup(message.groupId);
        break;
      case 'renameGroup':
        this.actions.showRenameGroupInput(message.groupId);
        break;
      case 'moveGroup':
        this.actions.moveGroup(message.groupId, message.direction);
        break;
      case 'moveGroupToIndex':
        this.actions.moveGroupToIndex(message.groupId, message.targetIndex);
        break;
      case 'setRoomGroups':
        this.actions.setRoomGroups(message.roomId, message.groupIds);
        break;
      case 'toggleAutoRefresh':
        this.actions.setAutoRefreshEnabled(message.enabled);
        break;
      case 'toggleLiveStartNotifications':
        this.actions.setLiveStartNotificationsEnabled(message.enabled);
        break;
      case 'setInterval':
        this.actions.setAutoRefreshInterval(message.intervalSeconds);
        break;
      case 'setDataRefreshInterval':
        this.actions.setDataRefreshInterval(message.kind, message.intervalSeconds);
        break;
      case 'loadHistoryDates':
        this.handleHistoryDates(message.requestId);
        break;
      case 'loadHistoryDate':
        this.handleHistoryDate(message.requestId, message.dates, message.startMinute, message.endMinute);
        break;
      case 'loadRoomSessions':
        this.handleRoomSessions(message.requestId, message.roomId);
        break;
    }
  }

  private handleHistoryDates(requestId: number): void {
    try {
      this.postMessage({
        type: 'historyDates',
        requestId,
        dates: this.actions.getHistoryDates()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '历史日期读取失败';
      void this.view?.webview.postMessage({
        type: 'historyDates',
        requestId,
        dates: [],
        error: message
      });
    }
  }

  private handleHistoryDate(requestId: number, dates: string[], startMinute: number, endMinute: number): void {
    try {
      void this.view?.webview.postMessage({
        type: 'historyDate',
        requestId,
        history: this.actions.queryHistoryDate(dates, startMinute, endMinute)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '历史数据读取失败';
      void this.view?.webview.postMessage({
        type: 'historyDate',
        requestId,
        history: {
          date: dates[0] || '',
          dates,
          startMs: 0,
          endMs: 0,
          rooms: []
        },
        error: message
      });
    }
  }

  private handleRoomSessions(requestId: number, roomId: string): void {
    try {
      void this.view?.webview.postMessage({
        type: 'roomSessions',
        requestId,
        roomId,
        anchorName: this.latestSnapshot.rooms.find((room) => room.roomId === roomId)?.anchorName || '',
        sessions: this.actions.getRoomSessions(roomId)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '主播历史读取失败';
      void this.view?.webview.postMessage({
        type: 'roomSessions',
        requestId,
        roomId,
        sessions: [],
        error: message
      });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'));

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${stylesUri}" rel="stylesheet">
  <title>BWatch</title>
</head>
<body>
  <main class="app">
    <section id="room-list-panel" class="subpanel room-list-panel" aria-label="直播间列表">
      <div class="subpanel-titlebar room-list-panel-header">
        <button id="room-list-toggle" class="subpanel-toggle aggregate-panel-toggle icon-button" type="button" aria-expanded="true" title="收起直播间列表" aria-label="收起直播间列表" aria-controls="room-list-content">
          <span class="disclosure-icon" aria-hidden="true"></span>
        </button>
        <span class="subpanel-title room-list-panel-title">直播间列表</span>
        <div class="subpanel-actions room-list-panel-actions">
          <button id="create-group-button" class="icon-button" title="新建分组" aria-label="新建分组">⊞</button>
          <button id="control-panel-toggle" class="icon-button control-panel-toggle" title="展开列表配置" aria-label="展开列表配置" aria-expanded="false" aria-controls="control-panel">⋯</button>
        </div>
      </div>
      <div id="room-list-content" class="subpanel-content room-list-panel-content">
        <section class="list-controls" aria-label="主列表控制">
          <div class="display-controls">
            <button id="display-mode-toggle" class="mode-toggle" title="切换展示模式">简略</button>
            <div class="status-filter" role="group" aria-label="主播状态筛选">
              <button id="filter-all-button" title="显示全部主播">全部</button>
              <button id="filter-live-button" title="只显示开播主播">开播</button>
              <button id="filter-offline-button" title="只显示未开播主播">未开播</button>
            </div>
          </div>
          <div class="list-trend-controls">
            <button id="trend-toggle" class="trend-toggle" title="展开在线人数走势">小图</button>
            <label class="trend-range-field">
              <span id="trend-window-label">最近 1 分钟</span>
              <input id="trend-window-range" type="range" min="1" max="360" step="1" value="1">
            </label>
          </div>
        </section>

        <section id="control-panel" class="control-panel collapsed" aria-label="列表配置" aria-hidden="true">
          <section class="control-section">
            <div class="control-section-title">排序</div>
            <div class="sort-filter-controls">
              <label class="sort-field">
                <span>字段</span>
                <select id="sort-field-select">
                  <option value="default">默认顺序</option>
                  <option value="live">是否开播</option>
                  <option value="online">在线人数</option>
                  <option value="guard">舰队人数</option>
                  <option value="fans">粉丝人数</option>
                  <option value="duration">直播时长</option>
                </select>
              </label>
              <button id="sort-direction-toggle" class="ghost-button" title="切换排序方向">大到小</button>
            </div>
          </section>

          <section class="control-section">
            <div class="control-section-title">刷新</div>
            <div class="settings-row">
              <label class="switch">
                <input id="auto-refresh-toggle" type="checkbox">
                <span>自动</span>
              </label>
              <label class="interval-field">
                <span>总轮询</span>
                <input id="interval-input" type="number" min="15" step="1">
                <span>s</span>
              </label>
              <label class="switch">
                <input id="live-start-notifications-toggle" type="checkbox">
                <span>提醒</span>
              </label>
            </div>
            <div class="data-refresh-grid">
              <label class="interval-field data-refresh-field">
                <span>房间状态</span>
                <input id="base-info-interval-input" type="number" min="15" step="1">
                <span>s</span>
              </label>
              <label class="interval-field data-refresh-field">
                <span>在线人数</span>
                <input id="online-interval-input" type="number" min="15" step="1">
                <span>s</span>
              </label>
              <label class="interval-field data-refresh-field">
                <span>粉丝数</span>
                <input id="fans-interval-input" type="number" min="15" step="1">
                <span>s</span>
              </label>
              <label class="interval-field data-refresh-field">
                <span>舰队人数</span>
                <input id="guard-interval-input" type="number" min="15" step="1">
                <span>s</span>
              </label>
            </div>
          </section>

          <section class="control-section">
            <div class="control-section-title">分组</div>
            <div class="group-controls">
              <div id="group-manager" class="group-manager" aria-label="自定义分组"></div>
            </div>
          </section>
        </section>

        <section id="summary" class="summary"></section>
        <section id="rooms" class="rooms"></section>
      </div>
    </section>

    <section id="overview-trend" class="subpanel overview-trend collapsed" aria-label="直播中主播总览走势">
      <div class="subpanel-titlebar aggregate-panel-titlebar">
        <button id="overview-trend-toggle" class="subpanel-toggle aggregate-panel-toggle icon-button" type="button" aria-expanded="false" title="展开主播总览" aria-label="展开主播总览" aria-controls="overview-trend-content">
          <span class="disclosure-icon" aria-hidden="true"></span>
        </button>
        <span class="subpanel-title aggregate-panel-title">主播总览</span>
        <div class="subpanel-actions aggregate-panel-actions">
          <button id="refresh-button" class="icon-button" title="立即刷新" aria-label="立即刷新">↻</button>
          <button id="open-search-button" class="icon-button" title="搜索添加直播间" aria-label="搜索添加直播间">＋</button>
        </div>
      </div>
      <div id="overview-trend-content" class="subpanel-content aggregate-panel-content hidden"></div>
    </section>
    <section id="history-trend" class="subpanel overview-trend history-trend collapsed" aria-label="历史在线人数走势">
      <div class="subpanel-titlebar aggregate-panel-titlebar">
        <button id="history-trend-toggle" class="subpanel-toggle aggregate-panel-toggle icon-button" type="button" aria-expanded="false" title="展开历史走势" aria-label="展开历史走势" aria-controls="history-trend-content">
          <span class="disclosure-icon" aria-hidden="true"></span>
        </button>
        <span class="subpanel-title aggregate-panel-title">历史走势</span>
      </div>
      <div id="history-trend-content" class="subpanel-content aggregate-panel-content hidden"></div>
    </section>
  </main>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function serializeSnapshot(snapshot: MonitorSnapshot): MonitorSnapshot & { lastRefreshText: string } {
  return {
    ...snapshot,
    lastRefreshText: formatUpdatedAt(snapshot.lastRefreshAt)
  };
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
