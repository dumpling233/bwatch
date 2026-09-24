import { brotliDecompressSync, inflateSync } from 'node:zlib';

export const DANMAKU_HEADER_SIZE = 16;
export const DANMAKU_HEARTBEAT_INTERVAL_MS = 30_000;

const MAX_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSION_DEPTH = 5;
const MAX_RECOVERY_SCAN_BYTES = 64 * 1024;

export enum DanmakuOperation {
  Heartbeat = 2,
  HeartbeatReply = 3,
  Message = 5,
  Auth = 7,
  AuthReply = 8
}

const VALID_OPERATIONS = new Set<number>([
  DanmakuOperation.Heartbeat,
  DanmakuOperation.HeartbeatReply,
  DanmakuOperation.Message,
  DanmakuOperation.Auth,
  DanmakuOperation.AuthReply
]);

export enum DanmakuProtocolVersion {
  Json = 0,
  Heartbeat = 1,
  Zlib = 2,
  Brotli = 3
}

export interface DecodedDanmakuPacket {
  operation: number;
  protocolVersion: number;
  sequence: number;
  body: Buffer;
}

export interface DanmakuDecodeError {
  offset: number;
  message: string;
}

export interface DanmakuDecodeResult {
  packets: DecodedDanmakuPacket[];
  errors: DanmakuDecodeError[];
}

export interface DanmakuMessage {
  id: string;
  roomId: string;
  receivedAt: number;
  sentAt?: number;
  uid: string;
  username: string;
  content: string;
  color?: number;
  medalName?: string;
  medalLevel?: number;
  isAdmin?: boolean;
}

export interface SuperChatMessage {
  id: string;
  roomId: string;
  receivedAt: number;
  uid: string;
  username: string;
  content: string;
  price: number;
  durationSeconds?: number;
  startedAt?: number;
  endsAt?: number;
  backgroundColor?: string;
  messageColor?: string;
  medalName?: string;
  medalLevel?: number;
  isAdmin?: boolean;
}

export function encodeDanmakuPacket(
  operation: number,
  body: string | Buffer = '',
  protocolVersion = DanmakuProtocolVersion.Heartbeat,
  sequence = 1
): Buffer {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(DANMAKU_HEADER_SIZE + bodyBuffer.length);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt16BE(DANMAKU_HEADER_SIZE, 4);
  packet.writeUInt16BE(protocolVersion, 6);
  packet.writeUInt32BE(operation, 8);
  packet.writeUInt32BE(sequence, 12);
  bodyBuffer.copy(packet, DANMAKU_HEADER_SIZE);
  return packet;
}

export function decodeDanmakuPackets(buffer: Buffer, depth = 0): DecodedDanmakuPacket[] {
  const result = decodeDanmakuPacketsSafely(buffer, depth);
  if (result.errors.length > 0) {
    throw new Error(result.errors[0]?.message ?? '弹幕协议解析失败');
  }
  return result.packets;
}

export function decodeDanmakuPacketsSafely(buffer: Buffer, depth = 0): DanmakuDecodeResult {
  if (depth > MAX_COMPRESSION_DEPTH) {
    return { packets: [], errors: [{ offset: 0, message: '弹幕协议压缩嵌套过深' }] };
  }

  const packets: DecodedDanmakuPacket[] = [];
  const errors: DanmakuDecodeError[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset < DANMAKU_HEADER_SIZE) {
      errors.push({ offset, message: '弹幕协议包头不完整' });
      break;
    }

    const packetLength = buffer.readUInt32BE(offset);
    const headerLength = buffer.readUInt16BE(offset + 4);
    const protocolVersion = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);
    const sequence = buffer.readUInt32BE(offset + 12);

    if (
      headerLength < DANMAKU_HEADER_SIZE ||
      packetLength < headerLength ||
      packetLength > MAX_PACKET_BYTES ||
      offset + packetLength > buffer.length
    ) {
      errors.push({ offset, message: '弹幕协议包长度无效' });
      const nextOffset = findNextPacketOffset(buffer, offset + 1);
      if (nextOffset === undefined) {
        break;
      }
      offset = nextOffset;
      continue;
    }

    const body = buffer.subarray(offset + headerLength, offset + packetLength);
    if (protocolVersion === DanmakuProtocolVersion.Zlib || protocolVersion === DanmakuProtocolVersion.Brotli) {
      try {
        const decompressed =
          protocolVersion === DanmakuProtocolVersion.Zlib
            ? inflateSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
            : brotliDecompressSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
        const nested = decodeDanmakuPacketsSafely(decompressed, depth + 1);
        packets.push(...nested.packets);
        errors.push(
          ...nested.errors.map((error) => ({
            offset,
            message: `弹幕压缩包内层解析失败：${error.message}`
          }))
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push({ offset, message: `弹幕协议压缩包解压失败：${detail}` });
      }
    } else {
      packets.push({ operation, protocolVersion, sequence, body });
    }

    offset += packetLength;
  }

  return { packets, errors };
}

export function parseDanmakuCommand(
  command: unknown,
  roomId: string,
  id: string,
  receivedAt = Date.now()
): DanmakuMessage | null {
  if (!isRecord(command) || typeof command.cmd !== 'string' || !command.cmd.startsWith('DANMU_MSG')) {
    return null;
  }

  const info = command.info;
  if (!Array.isArray(info) || typeof info[1] !== 'string') {
    return null;
  }

  const legacyUser = Array.isArray(info[2]) ? info[2] : [];
  const modernUser = readModernUser(info[0]);
  const medal = Array.isArray(info[3]) ? info[3] : [];
  const metadata = Array.isArray(info[0]) ? info[0] : [];
  const color = typeof metadata[3] === 'number' ? metadata[3] : undefined;
  const sentAt = normalizeEpochTimestamp(metadata[4]);

  return {
    id,
    roomId,
    receivedAt,
    ...(sentAt !== undefined ? { sentAt } : {}),
    uid: normalizeIdentifier(modernUser?.uid ?? legacyUser[0]),
    username: normalizeUsername(modernUser?.name ?? legacyUser[1]),
    content: info[1],
    color,
    medalLevel: typeof medal[0] === 'number' ? medal[0] : undefined,
    medalName: typeof medal[1] === 'string' && medal[1] ? medal[1] : undefined,
    isAdmin: legacyUser[2] === 1
  };
}

function findNextPacketOffset(buffer: Buffer, startOffset: number): number | undefined {
  const scanEnd = Math.min(buffer.length - DANMAKU_HEADER_SIZE, startOffset + MAX_RECOVERY_SCAN_BYTES);
  for (let offset = startOffset; offset <= scanEnd; offset += 1) {
    const packetLength = buffer.readUInt32BE(offset);
    const headerLength = buffer.readUInt16BE(offset + 4);
    const protocolVersion = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);
    if (
      headerLength === DANMAKU_HEADER_SIZE &&
      packetLength >= headerLength &&
      packetLength <= MAX_PACKET_BYTES &&
      offset + packetLength <= buffer.length &&
      protocolVersion <= DanmakuProtocolVersion.Brotli &&
      VALID_OPERATIONS.has(operation)
    ) {
      return offset;
    }
  }
  return undefined;
}

export function parseSuperChatCommand(
  command: unknown,
  roomId: string,
  fallbackId: string,
  receivedAt = Date.now()
): SuperChatMessage | null {
  if (
    !isRecord(command) ||
    (command.cmd !== 'SUPER_CHAT_MESSAGE' && command.cmd !== 'SUPER_CHAT_MESSAGE_JPN') ||
    !isRecord(command.data)
  ) {
    return null;
  }

  const data = command.data;
  const user = isRecord(data.user_info) ? data.user_info : {};
  const medal = isRecord(data.medal_info) ? data.medal_info : {};
  const startedAt = normalizeEpochSeconds(data.start_time);
  const endsAt = normalizeEpochSeconds(data.end_time);
  const declaredDuration = normalizePositiveNumber(data.time);
  const calculatedDuration =
    startedAt !== undefined && endsAt !== undefined && endsAt > startedAt ? (endsAt - startedAt) / 1000 : undefined;

  return {
    id: normalizeIdentifier(data.id) || fallbackId,
    roomId,
    receivedAt,
    uid: normalizeIdentifier(data.uid),
    username: normalizeUsername(user.uname ?? user.name),
    content: normalizeContent(data.message ?? data.message_trans),
    price: normalizeNonNegativeNumber(data.price),
    durationSeconds: declaredDuration ?? calculatedDuration,
    startedAt,
    endsAt,
    backgroundColor: normalizeHexColor(data.background_color_start ?? data.background_color),
    messageColor: normalizeHexColor(data.message_font_color),
    medalLevel: normalizeNonNegativeInteger(medal.medal_level),
    medalName: normalizeOptionalText(medal.medal_name),
    isAdmin: user.manager === 1
  };
}

export function parseSuperChatDeleteCommand(command: unknown): string[] {
  if (!isRecord(command) || command.cmd !== 'SUPER_CHAT_MESSAGE_DELETE' || !isRecord(command.data)) {
    return [];
  }
  const rawIds = Array.isArray(command.data.ids) ? command.data.ids : [command.data.id];
  return Array.from(new Set(rawIds.map((value) => normalizeIdentifier(value)).filter(Boolean)));
}

export function parseJsonBody(body: Buffer): unknown {
  return JSON.parse(body.toString('utf8')) as unknown;
}

function readModernUser(metadata: unknown): { uid?: unknown; name?: unknown } | null {
  if (!Array.isArray(metadata)) {
    return null;
  }
  const extra = metadata[15];
  if (!isRecord(extra) || !isRecord(extra.user) || !isRecord(extra.user.base)) {
    return null;
  }
  return {
    uid: extra.user.base.uid,
    name: extra.user.base.name
  };
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}

function normalizeUsername(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '匿名用户';
}

function normalizeContent(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeNonNegativeNumber(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function normalizeEpochSeconds(value: unknown): number | undefined {
  const seconds = normalizePositiveNumber(value);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

function normalizeEpochTimestamp(value: unknown): number | undefined {
  const timestamp = normalizePositiveNumber(value);
  if (timestamp === undefined) {
    return undefined;
  }
  return Math.round(timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp);
}

function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const color = value.trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
