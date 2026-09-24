import type * as vscode from 'vscode';
import type { DanmakuSessionEvent, DanmakuSnapshot } from './danmakuClient';
import type { DanmakuMessage } from './danmakuProtocol';

const STATUS_BAR_CONTENT_LIMIT = 48;
const EMOJI_PATTERN = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)/gu;
const EMOJI_TEXT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '👍': '点赞',
  '👎': '点踩',
  '😂': '笑哭',
  '🤣': '大笑',
  '😀': '开心',
  '😊': '微笑',
  '😭': '大哭',
  '😢': '难过',
  '😡': '生气',
  '🤢': '恶心',
  '❤': '爱心',
  '🔥': '火',
  '🎉': '庆祝',
  '👏': '鼓掌',
  '🙏': '感谢',
  '💪': '加油',
  '👀': '围观',
  '🤔': '思考',
  '😅': '尴尬',
  '😍': '喜欢',
  '😎': '酷',
  '💯': '满分',
  '🚀': '火箭',
  '🌹': '玫瑰',
  '🎂': '生日蛋糕',
  '🤡': '小丑',
  '👩‍💻': '女性程序员',
  '👨‍💻': '男性程序员',
  '🇨🇳': '中国国旗',
  '1⃣': '数字 1'
});

interface DanmakuStatusSession {
  getSnapshot(): DanmakuSnapshot;
  onDidEvent(listener: (event?: DanmakuSessionEvent) => void): () => void;
}

type DanmakuStatusItem = Pick<
  vscode.StatusBarItem,
  'text' | 'tooltip' | 'name' | 'accessibilityInformation' | 'show' | 'hide' | 'dispose'
>;

export class DanmakuStatusBar implements vscode.Disposable {
  private readonly unsubscribe: () => void;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private showEmoji = true;

  constructor(
    private readonly session: DanmakuStatusSession,
    private readonly item: DanmakuStatusItem,
    private enabled = true
  ) {
    this.item.name = 'BWatch 最新弹幕';
    this.unsubscribe = this.session.onDidEvent((event) => this.scheduleRender(event));
    this.render(this.session.getSnapshot());
  }

  dispose(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.unsubscribe();
    this.item.dispose();
  }

  setShowEmoji(showEmoji: boolean): void {
    this.showEmoji = showEmoji;
    this.render(this.session.getSnapshot());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.render(this.session.getSnapshot());
  }

  private scheduleRender(event?: DanmakuSessionEvent): void {
    if (!event || event.type !== 'message') {
      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = undefined;
      }
      this.render(this.session.getSnapshot());
      return;
    }
    if (this.renderTimer) {
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render(this.session.getSnapshot());
    }, 150);
  }

  private render(snapshot: DanmakuSnapshot): void {
    if (!this.enabled) {
      this.item.hide();
      return;
    }

    const latest = snapshot.messages[snapshot.messages.length - 1];
    if (latest) {
      const content = compactDanmakuContent(formatEmojiContent(latest.content, this.showEmoji));
      this.item.text = `${statusIcon(snapshot.status)} ${content}`;
      this.item.tooltip = buildDanmakuTooltip(latest, snapshot, formatEmojiContent(latest.content, this.showEmoji));
      this.item.accessibilityInformation = { label: `BWatch 最新弹幕：${content}` };
      this.item.show();
      return;
    }

    const pendingText = emptyStatusText(snapshot.status, !this.showEmoji);
    if (!pendingText) {
      this.item.hide();
      return;
    }
    this.item.text = pendingText;
    this.item.tooltip = snapshot.roomId ? `BWatch 实时弹幕 · 房间 ${snapshot.roomId}` : 'BWatch 实时弹幕';
    this.item.accessibilityInformation = { label: pendingText.replace(/^\$\([^)]*\)\s*/, '') };
    this.item.show();
  }
}

export function compactDanmakuContent(content: string, limit = STATUS_BAR_CONTENT_LIMIT): string {
  const normalized = String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\$\(/g, '＄(');
  if (!normalized) {
    return '（空弹幕）';
  }
  const characters = Array.from(normalized);
  const safeLimit = Math.max(1, Math.floor(limit));
  if (characters.length <= safeLimit) {
    return normalized;
  }
  return `${characters.slice(0, Math.max(0, safeLimit - 1)).join('')}…`;
}

export function formatEmojiContent(content: string, showEmoji: boolean): string {
  const text = String(content ?? '');
  if (showEmoji) {
    return text;
  }
  return text.replace(EMOJI_PATTERN, (sequence) => emojiSequenceToText(sequence));
}

function emojiSequenceToText(sequence: string): string {
  const normalized = sequence.replace(/[\uFE0E\uFE0F]/g, '').replace(/\p{Emoji_Modifier}/gu, '');
  const alias = EMOJI_TEXT_ALIASES[normalized];
  if (alias) {
    return `[${alias}]`;
  }
  const codePoints = Array.from(sequence)
    .filter((character) => character !== '\uFE0E' && character !== '\uFE0F')
    .map((character) => `U+${character.codePointAt(0)?.toString(16).toUpperCase()}`);
  return `[Emoji ${codePoints.join(' ')}]`;
}

function statusIcon(status: DanmakuSnapshot['status']): string {
  switch (status) {
    case 'connecting':
    case 'reconnecting':
      return '$(sync~spin)';
    case 'idle':
    case 'error':
      return '$(debug-disconnect)';
    default:
      return '$(comment-discussion)';
  }
}

function emptyStatusText(status: DanmakuSnapshot['status'], textOnly: boolean): string | null {
  switch (status) {
    case 'connecting':
      return '$(sync~spin) 正在连接弹幕';
    case 'connected':
      return textOnly ? '$(comment-discussion) 等待文字弹幕' : '$(comment-discussion) 等待弹幕';
    case 'reconnecting':
      return '$(sync~spin) 弹幕重连中';
    case 'error':
      return '$(warning) 弹幕连接失败';
    default:
      return null;
  }
}

function buildDanmakuTooltip(message: DanmakuMessage, snapshot: DanmakuSnapshot, content: string): string {
  const roomId = snapshot.actualRoomId || snapshot.roomId || message.roomId;
  const status = snapshot.status === 'connected' ? '已连接' : snapshot.status === 'idle' ? '已断开' : '连接状态变化中';
  const receivedAt = new Date(message.receivedAt).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  return [
    'BWatch 最新弹幕',
    `房间：${roomId}`,
    `状态：${status}`,
    `发送者：${message.username || '匿名用户'}`,
    `接收时间：${receivedAt}`,
    '',
    content || '（空弹幕）'
  ].join('\n');
}
