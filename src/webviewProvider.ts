import * as vscode from 'vscode';
import { formatUpdatedAt } from './time';
import { HistoryDateSummary, HistoryQueryResult, MonitorSnapshot } from './types';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openAddRoomPicker' }
  | { type: 'openCreateGroupInput' }
  | { type: 'removeRoom'; roomId: string }
  | { type: 'openRoom'; roomId: string }
  | { type: 'deleteGroup'; groupId: string }
  | { type: 'renameGroup'; groupId: string }
  | { type: 'moveGroup'; groupId: string; direction: 'up' | 'down' }
  | { type: 'moveGroupToIndex'; groupId: string; targetIndex: number }
  | { type: 'setRoomGroups'; roomId: string; groupIds: string[] }
  | { type: 'toggleAutoRefresh'; enabled: boolean }
  | { type: 'toggleLiveStartNotifications'; enabled: boolean }
  | { type: 'setInterval'; intervalSeconds: number }
  | { type: 'loadHistoryDates'; requestId: number }
  | { type: 'loadHistoryDate'; requestId: number; date: string; startMinute: number; endMinute: number };

export interface WebviewActions {
  refresh(): void;
  showAddRoomPicker(): void;
  showCreateGroupInput(): void;
  removeRoom(roomId: string): void;
  openRoom(roomId: string): void;
  deleteGroup(groupId: string): void;
  showRenameGroupInput(groupId: string): void;
  moveGroup(groupId: string, direction: 'up' | 'down'): void;
  moveGroupToIndex(groupId: string, targetIndex: number): void;
  setRoomGroups(roomId: string, groupIds: string[]): void;
  setAutoRefreshEnabled(enabled: boolean): void;
  setLiveStartNotificationsEnabled(enabled: boolean): void;
  setAutoRefreshInterval(intervalSeconds: number): void;
  getHistoryDates(): HistoryDateSummary[];
  queryHistoryDate(date: string, startMinute: number, endMinute: number): HistoryQueryResult;
}

export class LiveMonitorWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private latestSnapshot: MonitorSnapshot;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: WebviewActions,
    initialSnapshot: MonitorSnapshot
  ) {
    this.latestSnapshot = initialSnapshot;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
    this.update(this.latestSnapshot);
  }

  update(snapshot: MonitorSnapshot): void {
    this.latestSnapshot = snapshot;
    void this.view?.webview.postMessage({
      type: 'snapshot',
      snapshot: serializeSnapshot(snapshot)
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.update(this.latestSnapshot);
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
      case 'loadHistoryDates':
        this.handleHistoryDates(message.requestId);
        break;
      case 'loadHistoryDate':
        this.handleHistoryDate(message.requestId, message.date, message.startMinute, message.endMinute);
        break;
    }
  }

  private handleHistoryDates(requestId: number): void {
    try {
      void this.view?.webview.postMessage({
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

  private handleHistoryDate(requestId: number, date: string, startMinute: number, endMinute: number): void {
    try {
      void this.view?.webview.postMessage({
        type: 'historyDate',
        requestId,
        history: this.actions.queryHistoryDate(date, startMinute, endMinute)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '历史数据读取失败';
      void this.view?.webview.postMessage({
        type: 'historyDate',
        requestId,
        history: {
          date,
          startMs: 0,
          endMs: 0,
          rooms: []
        },
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
    <section class="toolbar" aria-label="管理工具栏">
      <div class="toolbar-spacer" aria-hidden="true"></div>
      <button id="refresh-button" class="icon-button" title="立即刷新" aria-label="立即刷新">↻</button>
      <button id="open-search-button" class="icon-button" title="搜索添加直播间" aria-label="搜索添加直播间">＋</button>
    </section>

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
            <div class="control-section-title">分组</div>
            <div class="group-controls">
              <div id="group-manager" class="group-manager" aria-label="自定义分组"></div>
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
                <span>间隔</span>
                <input id="interval-input" type="number" min="15" step="1">
                <span>s</span>
              </label>
              <label class="switch">
                <input id="live-start-notifications-toggle" type="checkbox">
                <span>提醒</span>
              </label>
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
