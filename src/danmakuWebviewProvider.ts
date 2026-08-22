import * as vscode from 'vscode';
import { BilibiliDanmakuSession, DanmakuSessionEvent, DanmakuSnapshot } from './danmakuClient';
import { DanmakuMessage } from './danmakuProtocol';
import { LiveRoomStatus } from './types';

interface DanmakuRoomOption {
  roomId: string;
  anchorName: string;
  title: string;
  status: LiveRoomStatus['status'];
  isLive: boolean;
  online: number | null;
  onlineStale: boolean;
  onlineLastSuccessAt?: number;
  guardCount: number | null;
  guardCountStale: boolean;
  guardCountLastSuccessAt?: number;
  fansCount: number | null;
  fansCountStale: boolean;
  fansCountLastSuccessAt?: number;
  liveStartTime: number | null;
  lastUpdatedAt: number;
}

interface DanmakuWebviewActions {
  openRoom(roomId: string): void;
  setShowEmoji(showEmoji: boolean): void;
  logDiagnostic(message: string): void;
}

interface DanmakuRenderDiagnostics {
  windowMs: number;
  batches: number;
  messages: number;
  maxDeliveryDelayMs: number;
  maxRenderDurationMs: number;
  timerDriftMs: number;
  listMessages: number;
  lastBatchId: number;
}

type DanmakuWebviewMessage =
  | { type: 'ready' }
  | { type: 'connect'; roomId: string }
  | { type: 'disconnect' }
  | { type: 'clear' }
  | { type: 'setShowEmoji'; showEmoji: boolean }
  | ({ type: 'renderDiagnostics' } & DanmakuRenderDiagnostics)
  | { type: 'openRoom'; roomId: string };

export class DanmakuWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private rooms: DanmakuRoomOption[];
  private pendingRoomSelection?: string;
  private readonly unsubscribe: () => void;
  private pendingMessages: DanmakuMessage[] = [];
  private messageFlushQueued = false;
  private messageBatchSequence = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: BilibiliDanmakuSession,
    private readonly actions: DanmakuWebviewActions,
    initialRooms: readonly LiveRoomStatus[]
  ) {
    this.rooms = mapRoomOptions(initialRooms);
    this.unsubscribe = session.onDidEvent((event) => this.handleSessionEvent(event));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: DanmakuWebviewMessage) => this.handleMessage(message));
    this.postInitialState();
  }

  updateRooms(rooms: readonly LiveRoomStatus[]): void {
    this.rooms = mapRoomOptions(rooms);
    void this.view?.webview.postMessage({ type: 'rooms', rooms: this.rooms });
  }

  connectRoom(roomId: string): void {
    const normalizedRoomId = String(roomId ?? '').trim();
    if (!/^\d+$/.test(normalizedRoomId)) {
      return;
    }
    this.pendingRoomSelection = normalizedRoomId;
    this.postPendingRoomSelection();
    this.session.connect(normalizedRoomId);
  }

  dispose(): void {
    this.pendingMessages = [];
    this.unsubscribe();
  }

  private handleMessage(message: DanmakuWebviewMessage): void {
    switch (message.type) {
      case 'ready':
        this.postInitialState();
        break;
      case 'connect':
        this.session.connect(String(message.roomId ?? ''));
        break;
      case 'disconnect':
        this.session.disconnect();
        break;
      case 'clear':
        this.session.clearMessages();
        break;
      case 'setShowEmoji':
        this.actions.setShowEmoji(message.showEmoji !== false);
        break;
      case 'renderDiagnostics':
        this.actions.logDiagnostic(formatRenderDiagnostics(message));
        break;
      case 'openRoom':
        this.actions.openRoom(String(message.roomId ?? ''));
        break;
    }
  }

  private handleSessionEvent(event: DanmakuSessionEvent): void {
    if (event.type === 'snapshot') {
      this.postSnapshot(event.snapshot, false);
      return;
    }
    if (event.type === 'message') {
      this.pendingMessages.push(event.message);
      if (!this.messageFlushQueued) {
        this.messageFlushQueued = true;
        queueMicrotask(() => this.flushPendingMessages());
      }
      return;
    }
    if (event.type === 'clear') {
      this.pendingMessages = [];
    }
    void this.view?.webview.postMessage(event);
  }

  private flushPendingMessages(): void {
    this.messageFlushQueued = false;
    const messages = this.pendingMessages.splice(0);
    if (messages.length === 0) {
      return;
    }
    const batchId = ++this.messageBatchSequence;
    const emittedAt = Date.now();
    const delivery = this.view?.webview.postMessage({ type: 'messageBatch', batchId, emittedAt, messages });
    if (!delivery) {
      this.actions.logDiagnostic(`Webview 批次未投递 batch=${batchId} messages=${messages.length} reason=view-unavailable`);
      return;
    }
    void delivery.then(
      (delivered) => {
        if (!delivered) {
          this.actions.logDiagnostic(`Webview 批次未投递 batch=${batchId} messages=${messages.length} reason=postMessage-false`);
        }
      },
      (error) => {
        this.actions.logDiagnostic(
          `Webview 批次投递异常 batch=${batchId} messages=${messages.length} error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    );
  }

  private postInitialState(): void {
    void this.view?.webview.postMessage({ type: 'rooms', rooms: this.rooms });
    this.postSnapshot(this.session.getSnapshot());
    this.postPendingRoomSelection();
  }

  private postPendingRoomSelection(): void {
    if (!this.view || !this.pendingRoomSelection) {
      return;
    }
    const roomId = this.pendingRoomSelection;
    this.pendingRoomSelection = undefined;
    void this.view.webview.postMessage({ type: 'selectRoom', roomId });
  }

  private postSnapshot(snapshot: DanmakuSnapshot, includeMessages = true): void {
    if (includeMessages) {
      void this.view?.webview.postMessage({ type: 'snapshot', snapshot });
      return;
    }
    const statusSnapshot = {
      status: snapshot.status,
      roomId: snapshot.roomId,
      actualRoomId: snapshot.actualRoomId,
      popularity: snapshot.popularity,
      reconnectAttempt: snapshot.reconnectAttempt,
      error: snapshot.error
    };
    void this.view?.webview.postMessage({ type: 'snapshot', snapshot: statusSnapshot });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'danmaku.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'danmaku.js'));

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${stylesUri}" rel="stylesheet">
  <title>实时弹幕机</title>
</head>
<body>
  <main class="danmaku-app">
    <form id="connection-form" class="connection-form">
      <label class="room-field">
        <span>监控房间</span>
        <select id="room-select" aria-label="选择监控房间"></select>
      </label>
      <label class="room-field custom-room-field">
        <span>其他房间</span>
        <input id="room-input" type="text" inputmode="numeric" pattern="[0-9]+" placeholder="直播间房间号" aria-label="其他直播间房间号">
      </label>
      <div class="connection-actions">
        <button id="connect-button" class="primary-button" type="submit">连接</button>
        <button id="disconnect-button" type="button" disabled>断开</button>
      </div>
    </form>

    <section class="status-bar" aria-live="polite">
      <span id="status-dot" class="status-dot idle" aria-hidden="true"></span>
      <span id="status-text">未连接</span>
      <span id="popularity" class="popularity"></span>
      <button id="open-room-button" class="icon-button" type="button" title="打开直播间" aria-label="打开直播间" disabled>↗</button>
    </section>

    <section id="room-info" class="room-info" aria-label="当前直播间信息" hidden>
      <div class="room-info-heading">
        <span id="room-live-dot" class="room-live-dot unknown" aria-hidden="true"></span>
        <div class="room-info-identity">
          <div class="room-info-name-line">
            <strong id="room-anchor-name" class="room-anchor-name">未选择房间</strong>
            <span id="room-live-state" class="room-live-state">未知</span>
          </div>
          <span id="room-title" class="room-title"></span>
        </div>
      </div>
      <div class="room-metrics">
        <div class="room-metric"><span>在线</span><strong id="room-online">-</strong></div>
        <div class="room-metric"><span>开播时长</span><strong id="room-duration">-</strong></div>
        <div class="room-metric"><span>舰队</span><strong id="room-guards">-</strong></div>
        <div class="room-metric"><span>粉丝</span><strong id="room-fans">-</strong></div>
      </div>
    </section>

    <div class="message-toolbar">
      <div class="message-tabs" role="tablist" aria-label="消息类型">
        <button id="danmaku-tab" class="message-tab active" type="button" role="tab" aria-selected="true" aria-controls="messages">弹幕 <span id="message-count" class="message-count">0</span></button>
        <button id="super-chat-tab" class="message-tab" type="button" role="tab" aria-selected="false" aria-controls="super-chats">SC <span id="super-chat-count" class="message-count">0</span></button>
      </div>
      <label class="auto-scroll-toggle">
        <input id="auto-scroll-toggle" type="checkbox" checked>
        <span>自动滚动</span>
      </label>
      <button id="display-settings-button" class="settings-button" type="button" aria-expanded="false" aria-controls="display-settings-panel">显示</button>
      <button id="clear-button" class="icon-button" type="button" title="清空弹幕和 SC" aria-label="清空弹幕和 SC">×</button>
    </div>

    <section id="display-settings-panel" class="display-settings-panel" aria-label="弹幕显示设置" hidden>
      <div class="display-settings-grid">
        <label class="display-option"><input type="checkbox" data-display-option="showTime"><span>接收时间</span></label>
        <label class="display-option"><input type="checkbox" data-display-option="showUsername"><span>发送者名称</span></label>
        <label class="display-option"><input type="checkbox" data-display-option="showUid"><span>发送者 UID</span></label>
        <label class="display-option"><input type="checkbox" data-display-option="showMedal"><span>粉丝牌</span></label>
        <label class="display-option"><input type="checkbox" data-display-option="showAdmin"><span>房管标记</span></label>
        <label class="display-option" title="发送者在 B站选择的弹幕文字颜色"><input type="checkbox" data-display-option="showColorBar"><span>弹幕颜色条</span></label>
        <label class="display-option" title="关闭后将 Unicode Emoji 替换为可读名称或 Unicode 转义文本"><input type="checkbox" data-display-option="showEmoji"><span>Emoji 表情</span></label>
      </div>
    </section>

    <section id="messages" class="messages" role="tabpanel" aria-labelledby="danmaku-tab" aria-label="实时弹幕列表">
      <div id="empty-state" class="empty-state">等待弹幕...</div>
    </section>
    <section id="super-chats" class="messages super-chats" role="tabpanel" aria-labelledby="super-chat-tab" aria-label="实时 SC 列表" hidden>
      <div id="super-chat-empty-state" class="empty-state">等待 SC...</div>
    </section>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function mapRoomOptions(rooms: readonly LiveRoomStatus[]): DanmakuRoomOption[] {
  return rooms
    .map((room, index) => ({
      roomId: room.roomId,
      anchorName: room.anchorName && room.anchorName !== '-' ? room.anchorName : room.roomId,
      title: room.title || '',
      status: room.status,
      isLive: room.status === 'live',
      online: room.online,
      onlineStale: room.onlineStale === true,
      onlineLastSuccessAt: room.onlineLastSuccessAt,
      guardCount: room.guardFleet?.total ?? null,
      guardCountStale: room.guardFleetStale === true,
      guardCountLastSuccessAt: room.guardFleetLastSuccessAt,
      fansCount: room.fansCount,
      fansCountStale: room.fansCountStale === true,
      fansCountLastSuccessAt: room.fansCountLastSuccessAt,
      liveStartTime: room.liveStartTime,
      lastUpdatedAt: room.lastUpdatedAt,
      index
    }))
    .sort((left, right) => Number(right.isLive) - Number(left.isLive) || left.index - right.index)
    .map(({ index: _index, ...room }) => room);
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let index = 0; index < 32; index += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function formatRenderDiagnostics(message: DanmakuRenderDiagnostics): string {
  const number = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return `Webview 窗口 window=${number(message.windowMs)}ms batches=${number(message.batches)} messages=${number(message.messages)} ` +
    `deliveryMax=${number(message.maxDeliveryDelayMs)}ms renderMax=${number(message.maxRenderDurationMs)}ms ` +
    `timerDrift=${number(message.timerDriftMs)}ms listMessages=${number(message.listMessages)} lastBatch=${number(message.lastBatchId)}`;
}
