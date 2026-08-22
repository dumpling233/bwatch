import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8');
}

function extractFunction(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`  function ${name}`);
  const end = source.indexOf(`\n  function ${nextName}`, start);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing boundary after ${name}`);
  return source.slice(start, end);
}

test('danmaku view exposes persisted metadata display controls', () => {
  const provider = readSource('src/danmakuWebviewProvider.ts');
  const source = readSource('media/danmaku.js');

  for (const option of ['showTime', 'showUsername', 'showUid', 'showMedal', 'showAdmin', 'showColorBar', 'showEmoji']) {
    assert.match(provider, new RegExp(`data-display-option="${option}"`));
  }
  assert.match(provider, /id="display-settings-button"[^>]*aria-controls="display-settings-panel"/);
  assert.match(source, /savedState\.displayOptions/);
  assert.match(source, /renderAllMessages\(\)/);
});

test('danmaku display options keep defaults while restoring explicit choices', () => {
  const source = readSource('media/danmaku.js');
  const defaults = {
    showTime: true,
    showUsername: true,
    showUid: false,
    showMedal: true,
    showAdmin: false,
    showColorBar: true,
    showEmoji: true
  };
  const context = vm.createContext({ DEFAULT_DISPLAY_OPTIONS: defaults, Object });
  vm.runInContext(extractFunction(source, 'normalizeDisplayOptions', 'persistDisplaySettings'), context);
  const normalize = vm.runInContext('normalizeDisplayOptions', context) as (value: unknown) => typeof defaults;

  assert.deepEqual(JSON.parse(JSON.stringify(normalize(null))), defaults);
  assert.deepEqual(JSON.parse(JSON.stringify(normalize({ showUsername: false, showUid: true, ignored: true }))), {
    ...defaults,
    showUsername: false,
    showUid: true
  });
});

test('danmaku renderer can hide every metadata field and the color bar independently', () => {
  const source = readSource('media/danmaku.js');
  const css = readSource('media/danmaku.css');
  const renderer = extractFunction(source, 'createMessageElement', 'updateMessageCount');

  assert.match(renderer, /displayOptions\.showTime/);
  assert.match(renderer, /displayOptions\.showUsername/);
  assert.match(renderer, /displayOptions\.showUid/);
  assert.match(renderer, /displayOptions\.showMedal/);
  assert.match(renderer, /displayOptions\.showAdmin/);
  assert.match(renderer, /formatEmojiContent\(message\.content, displayOptions\.showEmoji\)/);
  assert.match(renderer, /color-bar-hidden/);
  assert.match(renderer, /message-content-only/);
  assert.match(css, /\.message\.color-bar-hidden\s*\{[^}]*border-left:\s*0/s);
});

test('danmaku emoji display option replaces Unicode emoji with readable text', () => {
  const source = readSource('media/danmaku.js');
  const context = vm.createContext({
    String,
    Array,
    EMOJI_PATTERN: /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)/gu,
    EMOJI_TEXT_ALIASES: { '👍': '点赞', '👩‍💻': '女性程序员', '🇨🇳': '中国国旗', '1⃣': '数字 1' }
  });
  vm.runInContext(extractFunction(source, 'emojiSequenceToText', 'isMessageVisible'), context);
  const formatEmojiContent = vm.runInContext('formatEmojiContent', context) as (
    content: string,
    showEmoji: boolean
  ) => string;

  assert.equal(formatEmojiContent('文字 👍 👩‍💻 🇨🇳 1️⃣', false), '文字 [点赞] [女性程序员] [中国国旗] [数字 1]');
  assert.equal(formatEmojiContent('文字 [doge]', false), '文字 [doge]');
  assert.equal(formatEmojiContent('👍', false), '[点赞]');
  assert.equal(formatEmojiContent('🪿', false), '[Emoji U+1FABF]');
  assert.equal(formatEmojiContent('文字 👍', true), '文字 👍');
});

test('danmaku view exposes a persisted Super Chat tab', () => {
  const provider = readSource('src/danmakuWebviewProvider.ts');
  const source = readSource('media/danmaku.js');
  const css = readSource('media/danmaku.css');

  assert.match(provider, /id="danmaku-tab"[^>]*aria-controls="messages"/);
  assert.match(provider, /id="super-chat-tab"[^>]*aria-controls="super-chats"/);
  assert.match(provider, /id="super-chats"[^>]*role="tabpanel"/);
  assert.match(source, /savedState\.activeMessageView/);
  assert.match(source, /selectMessageView\('superChat'\)/);
  assert.match(css, /\.message-tab\.active\s*\{/);
  assert.match(css, /\.super-chat\s*\{/);
});

test('danmaku view handles and safely renders Super Chat updates', () => {
  const source = readSource('media/danmaku.js');
  const messageHandler = source.slice(
    source.indexOf("  window.addEventListener('message'"),
    source.indexOf('\n  function renderRoomOptions')
  );
  const renderer = extractFunction(source, 'createSuperChatElement', 'updateMessageCount');

  assert.match(messageHandler, /payload\.type === 'superChat'/);
  assert.match(messageHandler, /appendSuperChat\(payload\.superChat\)/);
  assert.match(messageHandler, /payload\.type === 'superChatDelete'/);
  assert.match(messageHandler, /removeSuperChats\(payload\.ids\)/);
  assert.match(renderer, /price\.textContent = formatPrice\(superChat\.price\)/);
  assert.match(renderer, /duration\.textContent = `\$\{Math\.round\(Number\(superChat\.durationSeconds\)\)\} 秒`/);
  assert.match(renderer, /username\.textContent = superChat\.username/);
  assert.match(renderer, /content\.textContent = formatEmojiContent\(superChat\.content, displayOptions\.showEmoji\)/);
  assert.doesNotMatch(renderer, /innerHTML/);
});

test('danmaku messages are batched across the extension bridge and appended in one DOM commit', () => {
  const provider = readSource('src/danmakuWebviewProvider.ts');
  const source = readSource('media/danmaku.js');
  const messageHandler = source.slice(
    source.indexOf("  window.addEventListener('message'"),
    source.indexOf('\n  function renderRoomOptions')
  );
  const batchRenderer = extractFunction(source, 'appendMessages', 'appendSuperChat');

  assert.match(provider, /queueMicrotask\(\(\) => this\.flushPendingMessages\(\)\)/);
  assert.match(provider, /type: 'messageBatch', batchId, emittedAt, messages/);
  assert.match(provider, /this\.postSnapshot\(event\.snapshot, false\)/);
  assert.match(messageHandler, /payload\.type === 'messageBatch'/);
  assert.match(messageHandler, /appendMessages\(payload\.messages\)/);
  assert.match(batchRenderer, /document\.createDocumentFragment\(\)/);
  assert.match(batchRenderer, /messagesElement\.appendChild\(fragment\)/);
  assert.equal((batchRenderer.match(/updateMessageCount\(\)/g) || []).length, 1);
  assert.equal((batchRenderer.match(/scrollToBottom\(\)/g) || []).length, 1);
});

test('danmaku room choices prioritize live rooms and show explicit live state marks', () => {
  const provider = readSource('src/danmakuWebviewProvider.ts');
  const source = readSource('media/danmaku.js');
  const renderer = extractFunction(source, 'renderRoomOptions', 'selectRoom');
  const mappingStart = provider.indexOf('function mapRoomOptions');
  const mappingEnd = provider.indexOf('\nfunction getNonce', mappingStart);
  const mappingSource = provider
    .slice(mappingStart, mappingEnd)
    .replace(
      'function mapRoomOptions(rooms: readonly LiveRoomStatus[]): DanmakuRoomOption[]',
      'function mapRoomOptions(rooms)'
    );
  const context = vm.createContext({ Number });
  vm.runInContext(mappingSource, context);
  const mapped = vm.runInContext(
    `mapRoomOptions([
      { roomId: '1', anchorName: '离线一', status: 'offline' },
      { roomId: '2', anchorName: '开播一', status: 'live' },
      { roomId: '3', anchorName: '未知', status: 'unknown' },
      { roomId: '4', anchorName: '开播二', status: 'live' }
    ])`,
    context
  ) as Array<{ roomId: string }>;

  assert.deepEqual(Array.from(mapped, (room) => room.roomId), ['2', '4', '1', '3']);
  assert.match(renderer, /room\.isLive \? '🟢' : '🔴'/);
  assert.match(renderer, /`\$\{liveMark\} \$\{room\.anchorName\} · \$\{room\.roomId\}`/);
});

test('external room selection switches to danmaku and connects through the existing session', () => {
  const provider = readSource('src/danmakuWebviewProvider.ts');
  const source = readSource('media/danmaku.js');
  const selector = extractFunction(source, 'selectRoom', 'renderSnapshot');

  assert.match(provider, /connectRoom\(roomId: string\): void/);
  assert.match(provider, /type: 'selectRoom', roomId/);
  assert.match(provider, /this\.session\.connect\(normalizedRoomId\)/);
  assert.match(source, /payload\.type === 'selectRoom'/);
  assert.match(selector, /roomSelect\.value = normalizedRoomId/);
  assert.match(selector, /selectMessageView\('danmaku'\)/);
});

test('danmaku room snapshot includes monitor metrics without adding another request path', () => {
  const provider = readSource('src/danmakuWebviewProvider.ts');
  const source = readSource('media/danmaku.js');

  for (const field of [
    'title',
    'status',
    'online',
    'guardCount',
    'fansCount',
    'liveStartTime',
    'lastUpdatedAt'
  ]) {
    assert.match(provider, new RegExp(`${field}: room\\.`));
  }
  assert.match(provider, /guardCount: room\.guardFleet\?\.total \?\? null/);
  assert.match(source, /monitoredRooms\.find\(\(item\) => item\.roomId === normalizedRoomId\)/);
  assert.match(source, /renderRoomInfo\(requestedRoomId \|\| currentRoomId \|\| roomSelect\.value\)/);
  assert.match(source, /setMetricValue\(roomOnline, room\.online/);
  assert.match(source, /setMetricValue\(roomGuards, room\.guardCount/);
  assert.match(source, /setMetricValue\(roomFans, room\.fansCount/);
  assert.doesNotMatch(provider, /fetchRooms|fetch\(/);
});

test('danmaku room information exposes compact live metrics and stale states', () => {
  const provider = readSource('src/danmakuWebviewProvider.ts');
  const source = readSource('media/danmaku.js');
  const css = readSource('media/danmaku.css');

  for (const id of ['room-anchor-name', 'room-title', 'room-online', 'room-duration', 'room-guards', 'room-fans']) {
    assert.match(provider, new RegExp(`id="${id}"`));
  }
  assert.match(source, /element\.classList\.add\('metric-stale'\)/);
  assert.match(source, /未加入在线人数监控列表/);
  assert.match(css, /\.room-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
  assert.match(css, /@media \(max-width: 260px\)[\s\S]*\.room-metrics\s*\{[^}]*repeat\(2,/);
});

test('danmaku room live duration uses a local one-second clock', () => {
  const source = readSource('media/danmaku.js');
  const context = vm.createContext({ Math, Number, String, Date });
  vm.runInContext(extractFunction(source, 'formatLiveDuration', 'formatLiveState'), context);
  const formatLiveDuration = vm.runInContext('formatLiveDuration', context) as (start: number, nowMs: number) => string;

  assert.equal(formatLiveDuration(1_000, 4_661_000), '01:01:01');
  assert.match(source, /setInterval\(updateRoomDuration, 1000\)/);
  assert.match(extractFunction(source, 'updateRoomDuration', 'formatLiveDuration'), /roomDuration\.textContent/);
  assert.doesNotMatch(extractFunction(source, 'updateRoomDuration', 'formatLiveDuration'), /renderAllMessages/);
});

test('danmaku diagnostics correlate extension traffic with Webview delivery and rendering', () => {
  const extension = readSource('src/extension.ts');
  const provider = readSource('src/danmakuWebviewProvider.ts');
  const source = readSource('media/danmaku.js');

  assert.match(provider, /type: 'messageBatch', batchId, emittedAt, messages/);
  assert.match(provider, /reason=postMessage-false/);
  assert.match(provider, /case 'renderDiagnostics'/);
  assert.match(extension, /logDiagnostic: \(message\) => output\.appendLine/);
  assert.match(source, /observeRenderBatch\(payload, performance\.now\(\) - renderStartedAt\)/);
  assert.match(source, /type: 'renderDiagnostics'/);
  assert.match(source, /\['connecting', 'connected', 'reconnecting'\]\.includes\(sessionStatus\)/);
  assert.match(source, /setInterval\(reportRenderDiagnostics, RENDER_DIAGNOSTIC_INTERVAL_MS\)/);
  assert.doesNotMatch(extractFunction(source, 'reportRenderDiagnostics', 'renderAllSuperChats'), /content|username|uid/);
});
