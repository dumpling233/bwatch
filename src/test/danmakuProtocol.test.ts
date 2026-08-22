import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import {
  DANMAKU_HEADER_SIZE,
  DanmakuOperation,
  DanmakuProtocolVersion,
  decodeDanmakuPackets,
  decodeDanmakuPacketsSafely,
  encodeDanmakuPacket,
  parseDanmakuCommand,
  parseJsonBody,
  parseSuperChatCommand,
  parseSuperChatDeleteCommand
} from '../danmakuProtocol';

test('encodeDanmakuPacket writes the 16-byte big-endian header', () => {
  const packet = encodeDanmakuPacket(DanmakuOperation.Auth, '{"roomid":6}');

  assert.equal(packet.readUInt32BE(0), packet.length);
  assert.equal(packet.readUInt16BE(4), DANMAKU_HEADER_SIZE);
  assert.equal(packet.readUInt16BE(6), DanmakuProtocolVersion.Heartbeat);
  assert.equal(packet.readUInt32BE(8), DanmakuOperation.Auth);
  assert.equal(packet.readUInt32BE(12), 1);
  assert.equal(packet.subarray(DANMAKU_HEADER_SIZE).toString('utf8'), '{"roomid":6}');
});

test('decodeDanmakuPackets reads concatenated uncompressed packets', () => {
  const first = encodeDanmakuPacket(DanmakuOperation.Message, '{"cmd":"A"}', DanmakuProtocolVersion.Json);
  const second = encodeDanmakuPacket(DanmakuOperation.Message, '{"cmd":"B"}', DanmakuProtocolVersion.Json);
  const packets = decodeDanmakuPackets(Buffer.concat([first, second]));

  assert.equal(packets.length, 2);
  assert.deepEqual(packets.map((packet) => parseJsonBody(packet.body)), [{ cmd: 'A' }, { cmd: 'B' }]);
});

test('decodeDanmakuPackets recursively expands zlib and Brotli bodies', () => {
  const inner = Buffer.concat([
    encodeDanmakuPacket(DanmakuOperation.Message, '{"cmd":"ZLIB"}', DanmakuProtocolVersion.Json),
    encodeDanmakuPacket(DanmakuOperation.Message, '{"cmd":"BROTLI"}', DanmakuProtocolVersion.Json)
  ]);
  const zlibPacket = encodeDanmakuPacket(
    DanmakuOperation.Message,
    deflateSync(inner),
    DanmakuProtocolVersion.Zlib
  );
  const brotliPacket = encodeDanmakuPacket(
    DanmakuOperation.Message,
    brotliCompressSync(inner),
    DanmakuProtocolVersion.Brotli
  );

  assert.deepEqual(
    decodeDanmakuPackets(zlibPacket).map((packet) => parseJsonBody(packet.body)),
    [{ cmd: 'ZLIB' }, { cmd: 'BROTLI' }]
  );
  assert.deepEqual(
    decodeDanmakuPackets(brotliPacket).map((packet) => parseJsonBody(packet.body)),
    [{ cmd: 'ZLIB' }, { cmd: 'BROTLI' }]
  );
});

test('decodeDanmakuPackets rejects invalid declared lengths', () => {
  const packet = encodeDanmakuPacket(DanmakuOperation.Message, '{}', DanmakuProtocolVersion.Json);
  packet.writeUInt32BE(packet.length + 10, 0);
  assert.throws(() => decodeDanmakuPackets(packet), /包长度无效/);
});

test('safe decoder keeps valid packets around one broken compressed packet', () => {
  const first = encodeDanmakuPacket(DanmakuOperation.Message, '{"cmd":"FIRST"}', DanmakuProtocolVersion.Json);
  const broken = encodeDanmakuPacket(
    DanmakuOperation.Message,
    Buffer.from('not-zlib-data'),
    DanmakuProtocolVersion.Zlib
  );
  const third = encodeDanmakuPacket(DanmakuOperation.Message, '{"cmd":"THIRD"}', DanmakuProtocolVersion.Json);

  const result = decodeDanmakuPacketsSafely(Buffer.concat([first, broken, third]));

  assert.deepEqual(result.packets.map((packet) => parseJsonBody(packet.body)), [{ cmd: 'FIRST' }, { cmd: 'THIRD' }]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? '', /解压失败/);
});

test('parseDanmakuCommand supports the classic DANMU_MSG user tuple', () => {
  const message = parseDanmakuCommand(
    {
      cmd: 'DANMU_MSG:4:0:2:2:2:0',
      info: [[0, 1, 25, 0xff3366], '经典弹幕', [123, 'Alice', 1], [5, '测试牌子']]
    },
    '6',
    'message-1',
    1234
  );

  assert.deepEqual(message, {
    id: 'message-1',
    roomId: '6',
    receivedAt: 1234,
    uid: '123',
    username: 'Alice',
    content: '经典弹幕',
    color: 0xff3366,
    medalLevel: 5,
    medalName: '测试牌子',
    isAdmin: true
  });
});

test('parseDanmakuCommand preserves the Bilibili send timestamp', () => {
  const message = parseDanmakuCommand(
    {
      cmd: 'DANMU_MSG',
      info: [[0, 1, 25, 0xffffff, 1_700_000_000], '带发送时间', [123, 'Alice', 0], []]
    },
    '6',
    'message-time',
    1_700_000_015_000
  );

  assert.equal(message?.sentAt, 1_700_000_000_000);
  assert.equal(message?.receivedAt, 1_700_000_015_000);
});

test('parseDanmakuCommand prefers the modern nested user fields', () => {
  const metadata: unknown[] = [0, 1, 25, 0x00aa55];
  metadata[15] = { user: { base: { uid: 456, name: 'Bob' } } };
  const message = parseDanmakuCommand(
    { cmd: 'DANMU_MSG', info: [metadata, '新版弹幕', [0, '', 0], []] },
    '7',
    'message-2'
  );

  assert.equal(message?.uid, '456');
  assert.equal(message?.username, 'Bob');
  assert.equal(message?.content, '新版弹幕');
});

test('parseDanmakuCommand ignores unrelated commands', () => {
  assert.equal(parseDanmakuCommand({ cmd: 'SEND_GIFT', info: [] }, '6', 'message-3'), null);
});

test('parseSuperChatCommand normalizes Super Chat fields', () => {
  const superChat = parseSuperChatCommand(
    {
      cmd: 'SUPER_CHAT_MESSAGE',
      data: {
        id: 987,
        uid: 456,
        message: '支持主播 👍',
        price: 30,
        time: 60,
        start_time: 1_700_000_000,
        end_time: 1_700_000_060,
        background_color_start: '#3171D2',
        message_font_color: '#A3F6FF',
        user_info: { uname: 'SC 用户', manager: 1 },
        medal_info: { medal_name: '测试牌', medal_level: 12 }
      }
    },
    '6',
    'fallback-id',
    1234
  );

  assert.deepEqual(superChat, {
    id: '987',
    roomId: '6',
    receivedAt: 1234,
    uid: '456',
    username: 'SC 用户',
    content: '支持主播 👍',
    price: 30,
    durationSeconds: 60,
    startedAt: 1_700_000_000_000,
    endsAt: 1_700_000_060_000,
    backgroundColor: '#3171D2',
    messageColor: '#A3F6FF',
    medalName: '测试牌',
    medalLevel: 12,
    isAdmin: true
  });
});

test('parseSuperChatCommand supports JPN events and safe fallbacks', () => {
  const superChat = parseSuperChatCommand(
    {
      cmd: 'SUPER_CHAT_MESSAGE_JPN',
      data: {
        message_trans: '翻译内容',
        price: '5',
        background_color: 'not-a-color',
        user_info: { name: '兼容用户' }
      }
    },
    '7',
    'fallback-id',
    5678
  );

  assert.equal(superChat?.id, 'fallback-id');
  assert.equal(superChat?.content, '翻译内容');
  assert.equal(superChat?.price, 5);
  assert.equal(superChat?.backgroundColor, undefined);
  assert.equal(superChat?.username, '兼容用户');
});

test('parseSuperChatDeleteCommand returns unique normalized ids', () => {
  assert.deepEqual(
    parseSuperChatDeleteCommand({ cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { ids: [987, '988', 987, null] } }),
    ['987', '988']
  );
  assert.deepEqual(parseSuperChatDeleteCommand({ cmd: 'SEND_GIFT', data: { ids: [987] } }), []);
});
