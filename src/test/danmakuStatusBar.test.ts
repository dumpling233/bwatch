import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DanmakuSnapshot } from '../danmakuClient';
import type { DanmakuMessage } from '../danmakuProtocol';
import { compactDanmakuContent, DanmakuStatusBar, formatEmojiContent } from '../danmakuStatusBar';

class FakeSession {
  private listener?: () => void;

  constructor(private snapshot: DanmakuSnapshot) {}

  getSnapshot(): DanmakuSnapshot {
    return this.snapshot;
  }

  onDidEvent(listener: () => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  update(snapshot: DanmakuSnapshot): void {
    this.snapshot = snapshot;
    this.listener?.();
  }
}

class FakeStatusItem {
  text = '';
  tooltip: string | undefined;
  name: string | undefined;
  accessibilityInformation: { label: string } | undefined;
  visible = false;
  disposed = false;

  show(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function snapshot(status: DanmakuSnapshot['status'], messages: DanmakuMessage[] = []): DanmakuSnapshot {
  return {
    status,
    roomId: '123',
    actualRoomId: '456',
    popularity: null,
    messages,
    superChats: [],
    reconnectAttempt: 0
  };
}

function message(content: string): DanmakuMessage {
  return {
    id: 'message-1',
    roomId: '456',
    receivedAt: new Date(2026, 7, 20, 12, 34, 56).getTime(),
    uid: '100',
    username: '测试用户',
    content
  };
}

test('compactDanmakuContent normalizes, escapes codicons, and truncates by Unicode character', () => {
  assert.equal(compactDanmakuContent('  第一行\n  第二行  '), '第一行 第二行');
  assert.equal(compactDanmakuContent('$(warning) 内容'), '＄(warning) 内容');
  assert.equal(compactDanmakuContent('甲乙丙丁', 3), '甲乙…');
  assert.equal(compactDanmakuContent('😀😀😀', 2), '😀…');
});

test('formatEmojiContent replaces Unicode emoji with readable aliases or escapes', () => {
  assert.equal(formatEmojiContent('文字 👍 👩‍💻 🇨🇳 1️⃣', false), '文字 [点赞] [女性程序员] [中国国旗] [数字 1]');
  assert.equal(formatEmojiContent('文字 [doge]', false), '文字 [doge]');
  assert.equal(formatEmojiContent('👍', false), '[点赞]');
  assert.equal(formatEmojiContent('🪿', false), '[Emoji U+1FABF]');
  assert.equal(formatEmojiContent('文字 👍', true), '文字 👍');
});

test('DanmakuStatusBar follows connection state and the latest message', () => {
  const session = new FakeSession(snapshot('idle'));
  const item = new FakeStatusItem();
  const statusBar = new DanmakuStatusBar(session, item);

  assert.equal(item.visible, false);
  assert.equal(item.name, 'BWatch 最新弹幕');

  session.update(snapshot('connecting'));
  assert.equal(item.visible, true);
  assert.match(item.text, /正在连接弹幕/);

  session.update(snapshot('connected'));
  assert.match(item.text, /等待弹幕/);

  const latest = message('这是一条实时弹幕');
  session.update(snapshot('connected', [latest]));
  assert.match(item.text, /这是一条实时弹幕/);
  assert.match(item.tooltip || '', /测试用户/);
  assert.match(item.tooltip || '', /这是一条实时弹幕/);

  session.update(snapshot('connected', [latest, message('只有表情 👍')]));
  statusBar.setShowEmoji(false);
  assert.match(item.text, /只有表情 \[点赞\]/);
  assert.doesNotMatch(item.text, /👍/);

  session.update(snapshot('connected', [latest, message('👍')]));
  assert.match(item.text, /\[点赞\]/);

  session.update(snapshot('idle', [latest]));
  assert.match(item.text, /^\$\(debug-disconnect\)/);
  assert.match(item.tooltip || '', /已断开/);

  session.update(snapshot('idle'));
  assert.equal(item.visible, false);

  statusBar.dispose();
  assert.equal(item.disposed, true);
});

test('DanmakuStatusBar can be disabled without losing the latest message', () => {
  const session = new FakeSession(snapshot('connected', [message('关闭前的弹幕')]));
  const item = new FakeStatusItem();
  const statusBar = new DanmakuStatusBar(session, item, false);

  assert.equal(statusBar.isEnabled(), false);
  assert.equal(item.visible, false);

  session.update(snapshot('connected', [message('关闭期间的新弹幕')]));
  assert.equal(item.visible, false);

  statusBar.setEnabled(true);
  assert.equal(statusBar.isEnabled(), true);
  assert.equal(item.visible, true);
  assert.match(item.text, /关闭期间的新弹幕/);

  statusBar.setEnabled(false);
  assert.equal(item.visible, false);
  statusBar.dispose();
});

test('extension manifest contributes the danmaku status bar shortcut', () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
  const command = manifest.contributes.commands.find(
    (item: { command: string }) => item.command === 'bwatch.toggleDanmakuStatusBar'
  );
  const keybinding = manifest.contributes.keybindings.find(
    (item: { command: string }) => item.command === 'bwatch.toggleDanmakuStatusBar'
  );

  assert.ok(command);
  assert.equal(keybinding.key, 'ctrl+alt+d');
  assert.equal(keybinding.mac, 'cmd+alt+d');
});
