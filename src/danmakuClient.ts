import { EventEmitter } from 'node:events';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket, { ClientOptions } from 'ws';
import {
  DANMAKU_HEARTBEAT_INTERVAL_MS,
  DecodedDanmakuPacket,
  DanmakuMessage,
  DanmakuOperation,
  SuperChatMessage,
  decodeDanmakuPacketsSafely,
  encodeDanmakuPacket,
  parseDanmakuCommand,
  parseJsonBody,
  parseSuperChatCommand,
  parseSuperChatDeleteCommand
} from './danmakuProtocol';
import { FetchLike, ResolvedProxy, formatNetworkError, getAutoLocalProxyUrls } from './network';
import { extractWbiKey, signWbiParams } from './wbiSigner';

const ROOM_INFO_URL = 'https://api.live.bilibili.com/room/v1/Room/get_info';
const DANMAKU_INFO_URL = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo';
const WBI_NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_MESSAGES = 500;
const MAX_SUPER_CHATS = 100;
const CONNECT_TIMEOUT_MS = 12_000;
const AUTH_TIMEOUT_MS = 10_000;
const TRANSPORT_PING_INTERVAL_MS = 10_000;
const TRANSPORT_INACTIVITY_TIMEOUT_MS = DANMAKU_HEARTBEAT_INTERVAL_MS + 15_000;
const EVENT_LOOP_DRIFT_TOLERANCE_MS = 5_000;
const DANMAKU_STARVATION_WINDOW_COUNT = 3;
const DANMAKU_STARVATION_MIN_SILENCE_MS = 30_000;
const DANMAKU_STARVATION_MIN_OTHER_COMMANDS = 12;
const DANMAKU_STARVATION_ROTATION_COOLDOWN_MS = 60_000;
const BUSINESS_MESSAGE_DELAY_MS = 8_000;
const BUSINESS_BATCH_SPAN_MS = 5_000;
const MAX_MEANINGFUL_MESSAGE_DELAY_MS = 10 * 60_000;
const HEALTHY_CONNECTION_MS = 60_000;
const HEALTHY_MESSAGE_COUNT = 5;
const WBI_KEY_TTL_MS = 11 * 60 * 60 * 1000 + 59 * 60 * 1000 + 30 * 1000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

export type DanmakuConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface DanmakuSnapshot {
  status: DanmakuConnectionStatus;
  roomId: string;
  actualRoomId?: string;
  popularity: number | null;
  messages: DanmakuMessage[];
  superChats: SuperChatMessage[];
  reconnectAttempt: number;
  error?: string;
}

export type DanmakuSessionEvent =
  | { type: 'snapshot'; snapshot: DanmakuSnapshot }
  | { type: 'message'; message: DanmakuMessage }
  | { type: 'superChat'; superChat: SuperChatMessage }
  | { type: 'superChatDelete'; ids: string[] }
  | { type: 'clear' };

export interface DanmakuHost {
  host: string;
  wss_port: number;
}

export interface DanmakuConnectionInfo {
  roomId: number;
  token: string;
  hosts: DanmakuHost[];
}

interface DanmakuRoute {
  host: DanmakuHost;
  proxyUrl: string | null;
  url: string;
}

export interface DanmakuSessionOptions {
  now?: () => number;
  log?: (message: string) => void;
  connectSocket?: (url: string, proxyUrl: string | null, signal?: AbortSignal) => Promise<WebSocket>;
}

interface WbiKeyCache {
  key: string;
  fetchedAt: number;
}

interface DanmakuTrafficWindow {
  startedAt: number;
  frames: number;
  bytes: number;
  packets: number;
  messagePackets: number;
  danmaku: number;
  superChats: number;
  otherCommands: number;
  decodeErrors: number;
  commandErrors: number;
  delayMinMs?: number;
  delayMaxMs?: number;
  sentAtMin?: number;
  sentAtMax?: number;
  commands: Map<string, number>;
}

class DanmakuInitializationError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = 'DanmakuInitializationError';
  }
}

export class BilibiliDanmakuSession {
  private readonly events = new EventEmitter();
  private socket?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private transportPingTimer?: NodeJS.Timeout;
  private authTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private healthyConnectionTimer?: NodeJS.Timeout;
  private lifecycleAbort?: AbortController;
  private generation = 0;
  private connectionAttemptGeneration = 0;
  private totalReconnectAttempts = 0;
  private messageSequence = 0;
  private manualStop = true;
  private connectionInfo?: DanmakuConnectionInfo;
  private wbiKeyCache?: WbiKeyCache;
  private lastSocketError?: string;
  private forceConnectionInfoRefresh = false;
  private routeCursor = 0;
  private currentRoute?: DanmakuRoute;
  private lastPongAt?: number;
  private lastHeartbeatSentAt?: number;
  private lastHeartbeatReplyAt?: number;
  private lastFrameAt?: number;
  private lastDanmakuAt?: number;
  private lastPingAt?: number;
  private pingRttMs?: number;
  private expectedTransportCheckAt?: number;
  private consecutiveMissedPongs = 0;
  private lastEventLoopStallAt?: number;
  private connectedAt?: number;
  private healthyMessageCount = 0;
  private delayedMessageStreak = 0;
  private consecutiveDanmakuStarvationWindows = 0;
  private danmakuStarvationOtherCommands = 0;
  private lastDanmakuStarvationRotationAt?: number;
  private frameSentAtMin?: number;
  private frameSentAtMax?: number;
  private pendingBusinessDegradation?: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly connectSocketImpl: (
    url: string,
    proxyUrl: string | null,
    signal?: AbortSignal
  ) => Promise<WebSocket>;
  private diagnosticTraffic: DanmakuTrafficWindow;
  private snapshot: DanmakuSnapshot = {
    status: 'idle',
    roomId: '',
    popularity: null,
    messages: [],
    superChats: [],
    reconnectAttempt: 0
  };

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly getProxy: () => ResolvedProxy,
    options: DanmakuSessionOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.connectSocketImpl = options.connectSocket ?? connectWebSocket;
    this.diagnosticTraffic = createTrafficWindow(this.now());
  }

  onDidEvent(listener: (event: DanmakuSessionEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  getSnapshot(): DanmakuSnapshot {
    return {
      ...this.snapshot,
      messages: [...this.snapshot.messages],
      superChats: [...this.snapshot.superChats]
    };
  }

  connect(roomId: string): void {
    const normalizedRoomId = normalizeRoomId(roomId);
    this.resetTransport();
    const generation = ++this.generation;

    if (!normalizedRoomId) {
      this.manualStop = true;
      this.snapshot = {
        status: 'error',
        roomId: roomId.trim(),
        popularity: null,
        messages: [],
        superChats: [],
        reconnectAttempt: 0,
        error: '请输入有效的 B站直播间房间号'
      };
      this.publishSnapshot();
      return;
    }

    this.manualStop = false;
    this.lifecycleAbort = new AbortController();
    this.connectionInfo = undefined;
    this.lastSocketError = undefined;
    this.forceConnectionInfoRefresh = false;
    this.routeCursor = 0;
    this.totalReconnectAttempts = 0;
    this.currentRoute = undefined;
    this.resetBusinessHealth();
    this.lastDanmakuStarvationRotationAt = undefined;
    this.snapshot = {
      status: 'connecting',
      roomId: normalizedRoomId,
      popularity: null,
      messages: [],
      superChats: [],
      reconnectAttempt: 0
    };
    this.events.emit('event', { type: 'clear' } satisfies DanmakuSessionEvent);
    this.publishSnapshot();
    void this.establishConnection(generation, true, false);
  }

  disconnect(): void {
    this.manualStop = true;
    this.generation += 1;
    this.resetTransport();
    this.snapshot = {
      ...this.snapshot,
      status: 'idle',
      popularity: null,
      reconnectAttempt: 0,
      error: undefined
    };
    this.publishSnapshot();
  }

  clearMessages(): void {
    this.snapshot = { ...this.snapshot, messages: [], superChats: [] };
    this.events.emit('event', { type: 'clear' } satisfies DanmakuSessionEvent);
  }

  dispose(): void {
    this.disconnect();
    this.events.removeAllListeners();
  }

  private async establishConnection(generation: number, reloadInfo: boolean, isReconnect: boolean): Promise<void> {
    const signal = this.lifecycleAbort?.signal;
    const attemptGeneration = ++this.connectionAttemptGeneration;
    if (!signal || this.manualStop || generation !== this.generation || signal.aborted) {
      return;
    }

    try {
      if (reloadInfo || !this.connectionInfo) {
        this.connectionInfo = await this.loadConnectionInfo(this.snapshot.roomId, signal);
        this.forceConnectionInfoRefresh = false;
      }
      if (!this.isConnectionAttemptActive(generation, attemptGeneration, signal)) {
        return;
      }

      this.snapshot = {
        ...this.snapshot,
        status: isReconnect ? 'reconnecting' : 'connecting',
        actualRoomId: String(this.connectionInfo.roomId),
        error: undefined
      };
      this.publishSnapshot();
      const socket = await this.openSocket(this.connectionInfo, signal, attemptGeneration);
      if (!this.isConnectionAttemptActive(generation, attemptGeneration, signal)) {
        socket.close();
        return;
      }
      this.bindSocket(socket, generation, attemptGeneration);
    } catch (error) {
      if (!this.isConnectionAttemptActive(generation, attemptGeneration, signal)) {
        return;
      }
      const message = error instanceof Error ? error.message : '实时弹幕连接失败';
      if (error instanceof DanmakuInitializationError && !error.retryable) {
        this.snapshot = { ...this.snapshot, status: 'error', error: message };
        this.publishSnapshot();
        return;
      }
      this.scheduleReconnect(generation, message);
    }
  }

  private isConnectionAttemptActive(
    generation: number,
    attemptGeneration: number,
    signal: AbortSignal
  ): boolean {
    return (
      !this.manualStop &&
      generation === this.generation &&
      attemptGeneration === this.connectionAttemptGeneration &&
      !signal.aborted
    );
  }

  private async loadConnectionInfo(roomId: string, signal?: AbortSignal): Promise<DanmakuConnectionInfo> {
    try {
      const roomUrl = new URL(ROOM_INFO_URL);
      roomUrl.searchParams.set('room_id', roomId);
      const roomPayload = await this.fetchJson<{
        code?: number;
        message?: string;
        data?: { room_id?: number };
      }>(roomUrl, {}, signal);
      const actualRoomId = roomPayload.data?.room_id;
      if (roomPayload.code !== 0 || typeof actualRoomId !== 'number' || actualRoomId <= 0) {
        throw new DanmakuInitializationError(
          roomPayload.message || '直播间不存在或无法解析真实房间号',
          roomPayload.code !== -400
        );
      }

      let configPayload = await this.fetchDanmakuConfig(actualRoomId, false, signal);
      if (configPayload.code === -352) {
        configPayload = await this.fetchDanmakuConfig(actualRoomId, true, signal);
      }
      const hosts = (configPayload.data?.host_list ?? []).filter(
        (host): host is DanmakuHost =>
          typeof host?.host === 'string' && host.host.length > 0 && typeof host.wss_port === 'number' && host.wss_port > 0
      );
      const token = configPayload.data?.token;
      if (configPayload.code !== 0 || typeof token !== 'string' || !token || hosts.length === 0) {
        throw new DanmakuInitializationError(
          configPayload.message || `弹幕服务器配置接口返回错误码 ${configPayload.code ?? 'unknown'}`
        );
      }

      return { roomId: actualRoomId, token, hosts };
    } catch (error) {
      if (error instanceof DanmakuInitializationError) {
        throw error;
      }
      throw new DanmakuInitializationError(formatNetworkError(error));
    }
  }

  private async fetchDanmakuConfig(
    roomId: number,
    forceRefreshWbi: boolean,
    signal?: AbortSignal
  ): Promise<{
    code?: number;
    message?: string;
    data?: { token?: string; host_list?: Array<Partial<DanmakuHost>> };
  }> {
    const wbiKey = await this.getWbiKey(forceRefreshWbi, signal);
    const url = new URL(DANMAKU_INFO_URL);
    url.search = signWbiParams({ id: roomId, type: 0 }, wbiKey).toString();
    return this.fetchJson(url, {
      origin: 'https://live.bilibili.com',
      referer: `https://live.bilibili.com/${roomId}`
    }, signal);
  }

  private async getWbiKey(forceRefresh: boolean, signal?: AbortSignal): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.wbiKeyCache && now - this.wbiKeyCache.fetchedAt < WBI_KEY_TTL_MS) {
      return this.wbiKeyCache.key;
    }

    const payload = await this.fetchJson<{
      data?: { wbi_img?: { img_url?: string; sub_url?: string } };
    }>(new URL(WBI_NAV_URL), {}, signal);
    const imgUrl = payload.data?.wbi_img?.img_url;
    const subUrl = payload.data?.wbi_img?.sub_url;
    if (!imgUrl || !subUrl) {
      throw new DanmakuInitializationError('无法获取 B站 WBI 签名参数');
    }
    const key = extractWbiKey(imgUrl, subUrl);
    if (!key) {
      throw new DanmakuInitializationError('无法生成 B站 WBI 签名密钥');
    }
    this.wbiKeyCache = { key, fetchedAt: now };
    return key;
  }

  private async fetchJson<T>(
    url: URL,
    headers: Record<string, string> = {},
    signal?: AbortSignal
  ): Promise<T> {
    const response = await this.fetchImpl(url, {
      signal,
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'user-agent': USER_AGENT,
        ...headers
      }
    });
    if (!response.ok) {
      throw new Error(`B站接口返回 HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async openSocket(
    info: DanmakuConnectionInfo,
    signal?: AbortSignal,
    attemptGeneration?: number
  ): Promise<WebSocket> {
    const proxyCandidates = getWebSocketProxyCandidates(this.getProxy());
    const routes = proxyCandidates.flatMap((proxyUrl) =>
      info.hosts.map((host) => ({
        host,
        proxyUrl,
        url: `wss://${host.host}:${host.wss_port}/sub`
      }))
    );
    if (routes.length === 0) {
      throw new Error('没有可用的弹幕服务器');
    }
    const routeIndex = this.routeCursor % routes.length;
    const route = routes[routeIndex];
    this.routeCursor = (routeIndex + 1) % routes.length;
    this.writeDiagnostic(
      `尝试弹幕线路 attemptGeneration=${attemptGeneration ?? 'manual'} ` +
        `routeIndex=${routeIndex + 1}/${routes.length} host=${route.host.host}:${route.host.wss_port} ` +
        `route=${formatRoute(route.proxyUrl)}`
    );
    try {
      const socket = await this.connectSocketImpl(route.url, route.proxyUrl, signal);
      this.currentRoute = route;
      this.writeDiagnostic(
        `弹幕线路已建立 attemptGeneration=${attemptGeneration ?? 'manual'} ` +
          `host=${route.host.host}:${route.host.wss_port} route=${formatRoute(route.proxyUrl)}`
      );
      return socket;
    } catch (error) {
      throw new Error(`${route.host.host} ${formatRoute(route.proxyUrl)}：${formatNetworkError(error)}`);
    }
  }

  private bindSocket(socket: WebSocket, generation: number, attemptGeneration: number): void {
    this.socket = socket;
    this.lastSocketError = undefined;
    this.resetBusinessHealth();
    this.expectedTransportCheckAt = this.now() + TRANSPORT_PING_INTERVAL_MS;
    socket.on('message', (data) => this.handleSocketMessage(socket, data));
    socket.on('pong', () => this.handleSocketPong(socket));
    socket.on('error', (error) => {
      if (this.socket !== socket || attemptGeneration !== this.connectionAttemptGeneration) {
        return;
      }
      this.lastSocketError = formatNetworkError(error);
    });
    socket.on('close', (_code, reason) => {
      if (this.socket !== socket || attemptGeneration !== this.connectionAttemptGeneration) {
        this.writeDiagnostic(`忽略旧弹幕连接的迟到关闭事件 attemptGeneration=${attemptGeneration}`);
        return;
      }
      this.socket = undefined;
      this.clearSocketTimers();
      if (this.manualStop || generation !== this.generation) {
        return;
      }
      const reasonText = reason.toString('utf8').trim();
      this.scheduleReconnect(generation, this.lastSocketError || reasonText || '弹幕长连接已断开');
    });

    const authBody = JSON.stringify({
      uid: 0,
      roomid: this.connectionInfo?.roomId,
      protover: 3,
      buvid: '',
      platform: 'web',
      type: 2,
      key: this.connectionInfo?.token
    });
    socket.send(encodeDanmakuPacket(DanmakuOperation.Auth, authBody));
    this.transportPingTimer = setInterval(
      () => this.checkTransportAlive(socket),
      TRANSPORT_PING_INTERVAL_MS
    );
    this.authTimer = setTimeout(() => {
      this.lastSocketError = '弹幕服务器认证超时';
      socket.close();
    }, AUTH_TIMEOUT_MS);
  }

  private handleSocketPong(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }
    const now = this.now();
    this.lastPongAt = now;
    this.consecutiveMissedPongs = 0;
    if (this.lastPingAt !== undefined) {
      this.pingRttMs = Math.max(0, now - this.lastPingAt);
    }
  }

  private handleSocketMessage(socket: WebSocket, data: WebSocket.RawData): void {
    if (this.socket !== socket) {
      return;
    }
    const receivedAt = this.now();
    this.lastFrameAt = receivedAt;
    this.frameSentAtMin = undefined;
    this.frameSentAtMax = undefined;
    this.pendingBusinessDegradation = undefined;
    const buffer = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    const decoded = decodeDanmakuPacketsSafely(buffer);
    this.diagnosticTraffic.frames += 1;
    this.diagnosticTraffic.bytes += buffer.length;
    this.diagnosticTraffic.packets += decoded.packets.length;
    this.diagnosticTraffic.decodeErrors += decoded.errors.length;
    if (decoded.errors.length > 0) {
      this.writeDiagnostic(
        `弹幕帧局部解析异常 errors=${decoded.errors.length} packets=${decoded.packets.length} detail=${decoded.errors[0]?.message ?? 'unknown'}`
      );
    }

    for (const packet of decoded.packets) {
      if (packet.operation === DanmakuOperation.Message) {
        this.diagnosticTraffic.messagePackets += 1;
      }
      try {
        this.handleDecodedPacket(socket, packet, receivedAt);
      } catch (error) {
        this.diagnosticTraffic.commandErrors += 1;
        this.writeDiagnostic(`弹幕命令解析异常：${error instanceof Error ? error.message : String(error)}`);
        // One malformed command must not discard the remaining commands in the same frame.
      }
    }
    this.finishBusinessFrame(socket);
  }

  private handleDecodedPacket(socket: WebSocket, packet: DecodedDanmakuPacket, receivedAt = this.now()): void {
    if (packet.operation === DanmakuOperation.AuthReply) {
      const reply = parseJsonBody(packet.body);
      if (!isRecord(reply) || reply.code !== 0) {
        this.forceConnectionInfoRefresh = true;
        this.lastSocketError = `弹幕服务器认证失败：${isRecord(reply) ? String(reply.code ?? 'unknown') : 'unknown'}`;
        socket.close();
        return;
      }
      if (this.authTimer) {
        clearTimeout(this.authTimer);
        this.authTimer = undefined;
      }
      this.snapshot = {
        ...this.snapshot,
        status: 'connected',
        popularity: null,
        error: undefined
      };
      this.connectedAt = receivedAt;
      this.scheduleHealthyConnectionReset(socket);
      this.writeDiagnostic(
        `弹幕认证成功 reconnectAttempt=${this.snapshot.reconnectAttempt} ${this.formatCurrentRouteDiagnostics()}`
      );
      this.publishSnapshot();
      this.sendHeartbeat(socket);
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(socket), DANMAKU_HEARTBEAT_INTERVAL_MS);
      return;
    }

    if (packet.operation === DanmakuOperation.HeartbeatReply && packet.body.length >= 4) {
      this.lastHeartbeatReplyAt = receivedAt;
      this.snapshot = { ...this.snapshot, popularity: packet.body.readUInt32BE(0) };
      this.publishSnapshot();
      return;
    }

    if (packet.operation !== DanmakuOperation.Message) {
      return;
    }

    const command = parseJsonBody(packet.body);
    const commandName = getDiagnosticCommandName(command);
    this.diagnosticTraffic.commands.set(
      commandName,
      (this.diagnosticTraffic.commands.get(commandName) ?? 0) + 1
    );
    const eventId = `${receivedAt}-${++this.messageSequence}`;
    const message = parseDanmakuCommand(
      command,
      this.snapshot.actualRoomId || this.snapshot.roomId,
      eventId,
      receivedAt
    );
    if (message) {
      this.diagnosticTraffic.danmaku += 1;
      this.observeTrafficTiming(message);
      this.observeDanmakuMessage(message);
      this.appendMessage(message);
      return;
    }
    const superChat = parseSuperChatCommand(
      command,
      this.snapshot.actualRoomId || this.snapshot.roomId,
      eventId,
      receivedAt
    );
    if (superChat) {
      this.diagnosticTraffic.superChats += 1;
      this.appendSuperChat(superChat);
      return;
    }
    const deletedSuperChatIds = parseSuperChatDeleteCommand(command);
    if (deletedSuperChatIds.length > 0) {
      this.removeSuperChats(deletedSuperChatIds);
      return;
    }
    this.diagnosticTraffic.otherCommands += 1;
  }

  private observeTrafficTiming(message: DanmakuMessage): void {
    if (message.sentAt === undefined) {
      return;
    }
    const delayMs = message.receivedAt - message.sentAt;
    this.diagnosticTraffic.delayMinMs = Math.min(this.diagnosticTraffic.delayMinMs ?? delayMs, delayMs);
    this.diagnosticTraffic.delayMaxMs = Math.max(this.diagnosticTraffic.delayMaxMs ?? delayMs, delayMs);
    this.diagnosticTraffic.sentAtMin = Math.min(this.diagnosticTraffic.sentAtMin ?? message.sentAt, message.sentAt);
    this.diagnosticTraffic.sentAtMax = Math.max(this.diagnosticTraffic.sentAtMax ?? message.sentAt, message.sentAt);
  }

  private observeDanmakuMessage(message: DanmakuMessage): void {
    this.lastDanmakuAt = message.receivedAt;
    this.consecutiveDanmakuStarvationWindows = 0;
    this.danmakuStarvationOtherCommands = 0;
    if (message.sentAt === undefined) {
      return;
    }

    this.frameSentAtMin = Math.min(this.frameSentAtMin ?? message.sentAt, message.sentAt);
    this.frameSentAtMax = Math.max(this.frameSentAtMax ?? message.sentAt, message.sentAt);
    const delayMs = message.receivedAt - message.sentAt;
    const isMeaningfullyDelayed = delayMs > BUSINESS_MESSAGE_DELAY_MS && delayMs <= MAX_MEANINGFUL_MESSAGE_DELAY_MS;
    if (isMeaningfullyDelayed) {
      this.delayedMessageStreak += 1;
      this.healthyMessageCount = 0;
      if (this.delayedMessageStreak >= 2) {
        this.pendingBusinessDegradation = `连续 ${this.delayedMessageStreak} 条弹幕延迟，最新延迟 ${delayMs}ms`;
      }
      return;
    }

    this.delayedMessageStreak = 0;
    if (delayMs <= BUSINESS_MESSAGE_DELAY_MS) {
      this.healthyMessageCount += 1;
      if (this.healthyMessageCount >= HEALTHY_MESSAGE_COUNT) {
        this.markConnectionHealthy('连续低延迟弹幕');
      }
    }
  }

  private finishBusinessFrame(socket: WebSocket): void {
    if (this.frameSentAtMin !== undefined && this.frameSentAtMax !== undefined) {
      const spanMs = this.frameSentAtMax - this.frameSentAtMin;
      if (spanMs > BUSINESS_BATCH_SPAN_MS) {
        this.pendingBusinessDegradation = `同一批弹幕发送时间跨度 ${spanMs}ms`;
      }
    }
    const degradation = this.pendingBusinessDegradation;
    this.frameSentAtMin = undefined;
    this.frameSentAtMax = undefined;
    this.pendingBusinessDegradation = undefined;
    if (!degradation || this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (
      this.lastEventLoopStallAt !== undefined &&
      this.now() - this.lastEventLoopStallAt <= TRANSPORT_PING_INTERVAL_MS * 2
    ) {
      this.delayedMessageStreak = 0;
      this.healthyMessageCount = 0;
      this.writeDiagnostic(`检测到弹幕时间滞后，但近期存在 Extension Host 阻塞，本批不轮换线路：${degradation}`);
      return;
    }

    this.lastSocketError = `弹幕业务消息延迟：${degradation}`;
    this.writeDiagnostic(`检测到业务流退化，将轮换线路：${degradation}；${this.formatCurrentRouteDiagnostics()}`);
    socket.terminate();
  }

  private scheduleHealthyConnectionReset(socket: WebSocket): void {
    if (this.healthyConnectionTimer) {
      clearTimeout(this.healthyConnectionTimer);
    }
    this.healthyConnectionTimer = setTimeout(() => {
      this.healthyConnectionTimer = undefined;
      if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
        this.markConnectionHealthy('连接稳定 60 秒');
      }
    }, HEALTHY_CONNECTION_MS);
  }

  private markConnectionHealthy(reason: string): void {
    if (this.snapshot.reconnectAttempt === 0) {
      return;
    }
    this.snapshot = { ...this.snapshot, reconnectAttempt: 0 };
    this.writeDiagnostic(`弹幕连接恢复健康：${reason}`);
    this.publishSnapshot();
  }

  private appendMessage(message: DanmakuMessage): void {
    const messages = [...this.snapshot.messages, message];
    if (messages.length > MAX_MESSAGES) {
      messages.splice(0, messages.length - MAX_MESSAGES);
    }
    this.snapshot = { ...this.snapshot, messages };
    this.events.emit('event', { type: 'message', message } satisfies DanmakuSessionEvent);
  }

  private appendSuperChat(superChat: SuperChatMessage): void {
    const superChats = this.snapshot.superChats.filter((item) => item.id !== superChat.id);
    superChats.push(superChat);
    if (superChats.length > MAX_SUPER_CHATS) {
      superChats.splice(0, superChats.length - MAX_SUPER_CHATS);
    }
    this.snapshot = { ...this.snapshot, superChats };
    this.events.emit('event', { type: 'superChat', superChat } satisfies DanmakuSessionEvent);
  }

  private removeSuperChats(ids: string[]): void {
    const deletedIds = new Set(ids);
    const superChats = this.snapshot.superChats.filter((item) => !deletedIds.has(item.id));
    if (superChats.length === this.snapshot.superChats.length) {
      return;
    }
    this.snapshot = { ...this.snapshot, superChats };
    this.events.emit('event', { type: 'superChatDelete', ids } satisfies DanmakuSessionEvent);
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
      this.lastHeartbeatSentAt = this.now();
      socket.send(encodeDanmakuPacket(DanmakuOperation.Heartbeat));
    }
  }

  private checkTransportAlive(socket: WebSocket): void {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const now = this.now();
    const driftMs = this.expectedTransportCheckAt === undefined ? 0 : now - this.expectedTransportCheckAt;
    this.expectedTransportCheckAt = now + TRANSPORT_PING_INTERVAL_MS;
    const traffic = this.writeTrafficWindowDiagnostic(now);
    if (this.lastPingAt !== undefined && (this.lastPongAt === undefined || this.lastPongAt < this.lastPingAt)) {
      this.consecutiveMissedPongs = Math.min(this.consecutiveMissedPongs + 1, 999);
    }
    if (driftMs > EVENT_LOOP_DRIFT_TOLERANCE_MS) {
      this.lastEventLoopStallAt = now;
      this.writeDiagnostic(`Extension Host 事件循环延迟 ${driftMs}ms，本轮不判定网络超时`);
    } else {
      if (this.evaluateDanmakuStarvation(socket, traffic, now)) {
        return;
      }
      const lastActivityAt = this.getLastTransportActivityAt();
      const inactivityMs = lastActivityAt === undefined ? 0 : now - lastActivityAt;
      if (lastActivityAt !== undefined && inactivityMs >= TRANSPORT_INACTIVITY_TIMEOUT_MS) {
        this.lastSocketError = '弹幕长连接 45 秒未收到入站数据';
        this.writeDiagnostic(
          `传输层持续静默 ${inactivityMs}ms，将轮换线路；${this.formatCurrentRouteDiagnostics()}`
        );
        socket.terminate();
        return;
      }
    }
    this.lastPingAt = now;
    socket.ping();
  }

  private evaluateDanmakuStarvation(
    socket: WebSocket,
    traffic: DanmakuTrafficWindow,
    now: number
  ): boolean {
    const lastDanmakuAt = this.lastDanmakuAt;
    const hasRecentEventLoopStall =
      this.lastEventLoopStallAt !== undefined &&
      now - this.lastEventLoopStallAt <= TRANSPORT_PING_INTERVAL_MS * 2;

    if (
      lastDanmakuAt === undefined ||
      traffic.messagePackets === 0 ||
      traffic.danmaku > 0 ||
      traffic.otherCommands === 0 ||
      hasRecentEventLoopStall
    ) {
      if (hasRecentEventLoopStall && this.consecutiveDanmakuStarvationWindows > 0) {
        this.writeDiagnostic('近期存在 Extension Host 阻塞，清除文本弹幕饥饿观察窗口');
      }
      this.consecutiveDanmakuStarvationWindows = 0;
      this.danmakuStarvationOtherCommands = 0;
      return false;
    }

    this.consecutiveDanmakuStarvationWindows = Math.min(
      this.consecutiveDanmakuStarvationWindows + 1,
      999
    );
    this.danmakuStarvationOtherCommands = Math.min(
      this.danmakuStarvationOtherCommands + traffic.otherCommands,
      999_999
    );
    const silenceMs = Math.max(0, now - lastDanmakuAt);
    this.writeDiagnostic(
      `文本弹幕饥饿观察 windows=${this.consecutiveDanmakuStarvationWindows} ` +
        `other=${this.danmakuStarvationOtherCommands} silence=${silenceMs}ms；${this.formatCurrentRouteDiagnostics()}`
    );

    if (
      this.consecutiveDanmakuStarvationWindows < DANMAKU_STARVATION_WINDOW_COUNT ||
      this.danmakuStarvationOtherCommands < DANMAKU_STARVATION_MIN_OTHER_COMMANDS ||
      silenceMs < DANMAKU_STARVATION_MIN_SILENCE_MS
    ) {
      return false;
    }

    const sinceLastRotationMs =
      this.lastDanmakuStarvationRotationAt === undefined
        ? Number.POSITIVE_INFINITY
        : now - this.lastDanmakuStarvationRotationAt;
    if (sinceLastRotationMs < DANMAKU_STARVATION_ROTATION_COOLDOWN_MS) {
      this.writeDiagnostic(
        `文本弹幕饥饿已达到阈值，但线路轮换仍在冷却期 remaining=${
          DANMAKU_STARVATION_ROTATION_COOLDOWN_MS - sinceLastRotationMs
        }ms`
      );
      return false;
    }

    this.lastDanmakuStarvationRotationAt = now;
    this.lastSocketError =
      `弹幕业务流选择性中断：连续 ${this.consecutiveDanmakuStarvationWindows} 个窗口无文本弹幕，` +
      `期间收到 ${this.danmakuStarvationOtherCommands} 条其他业务命令`;
    this.writeDiagnostic(
      `检测到文本弹幕选择性饥饿，将轮换线路 windows=${this.consecutiveDanmakuStarvationWindows} ` +
        `other=${this.danmakuStarvationOtherCommands} silence=${silenceMs}ms；${this.formatCurrentRouteDiagnostics()}`
    );
    socket.terminate();
    return true;
  }

  private scheduleReconnect(generation: number, error: string): void {
    if (this.manualStop || generation !== this.generation || this.reconnectTimer) {
      return;
    }
    const attempt = this.snapshot.reconnectAttempt + 1;
    this.totalReconnectAttempts += 1;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)];
    this.snapshot = {
      ...this.snapshot,
      status: 'reconnecting',
      reconnectAttempt: attempt,
      error
    };
    this.writeDiagnostic(
      `安排弹幕重连 attempt=${attempt} totalAttempt=${this.totalReconnectAttempts} ` +
        `delay=${delay}ms error=${error} nextRouteIndex=${this.routeCursor}`
    );
    this.publishSnapshot();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      const routeCount = this.getConnectionRouteCount();
      const reloadPeriod = Math.max(3, routeCount);
      const reloadInfo = this.forceConnectionInfoRefresh || attempt % reloadPeriod === 0;
      void this.establishConnection(generation, reloadInfo, true);
    }, delay);
  }

  private getConnectionRouteCount(): number {
    const hostCount = this.connectionInfo?.hosts.length ?? 0;
    if (hostCount === 0) {
      return 0;
    }
    return hostCount * getWebSocketProxyCandidates(this.getProxy()).length;
  }

  private publishSnapshot(): void {
    this.events.emit('event', { type: 'snapshot', snapshot: this.getSnapshot() } satisfies DanmakuSessionEvent);
  }

  private resetBusinessHealth(): void {
    this.lastPongAt = undefined;
    this.lastHeartbeatSentAt = undefined;
    this.lastHeartbeatReplyAt = undefined;
    this.lastFrameAt = undefined;
    this.lastDanmakuAt = undefined;
    this.lastPingAt = undefined;
    this.pingRttMs = undefined;
    this.expectedTransportCheckAt = undefined;
    this.consecutiveMissedPongs = 0;
    this.lastEventLoopStallAt = undefined;
    this.connectedAt = undefined;
    this.healthyMessageCount = 0;
    this.delayedMessageStreak = 0;
    this.consecutiveDanmakuStarvationWindows = 0;
    this.danmakuStarvationOtherCommands = 0;
    this.frameSentAtMin = undefined;
    this.frameSentAtMax = undefined;
    this.pendingBusinessDegradation = undefined;
    this.diagnosticTraffic = createTrafficWindow(this.now());
  }

  private writeTrafficWindowDiagnostic(now: number): DanmakuTrafficWindow {
    const traffic = this.diagnosticTraffic;
    const windowMs = Math.max(0, now - traffic.startedAt);
    const delayRange =
      traffic.delayMinMs === undefined || traffic.delayMaxMs === undefined
        ? 'unknown'
        : `${traffic.delayMinMs}..${traffic.delayMaxMs}ms`;
    const sentSpanMs =
      traffic.sentAtMin === undefined || traffic.sentAtMax === undefined
        ? 'unknown'
        : Math.max(0, traffic.sentAtMax - traffic.sentAtMin);
    const sentSpan = sentSpanMs === 'unknown' ? sentSpanMs : `${sentSpanMs}ms`;
    const commandSummary = Array.from(traffic.commands.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([command, count]) => `${command}:${count}`)
      .join(',') || 'none';
    this.writeDiagnostic(
      `流量窗口 window=${windowMs}ms frames=${traffic.frames} bytes=${traffic.bytes} packets=${traffic.packets} ` +
        `messagePackets=${traffic.messagePackets} danmaku=${traffic.danmaku} sc=${traffic.superChats} ` +
        `other=${traffic.otherCommands} decodeErrors=${traffic.decodeErrors} commandErrors=${traffic.commandErrors} ` +
        `delay=${delayRange} sentSpan=${sentSpan} commands=${commandSummary}；${this.formatCurrentRouteDiagnostics()}`
    );
    this.diagnosticTraffic = createTrafficWindow(now);
    return traffic;
  }

  private getLastTransportActivityAt(): number | undefined {
    const timestamps = [this.connectedAt, this.lastFrameAt, this.lastPongAt].filter(
      (value): value is number => value !== undefined
    );
    return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
  }

  private formatCurrentRouteDiagnostics(): string {
    const route = this.currentRoute;
    const lastActivityAt = this.getLastTransportActivityAt();
    const inactivityMs = lastActivityAt === undefined ? 'unknown' : Math.max(0, this.now() - lastActivityAt);
    return [
      `host=${route ? `${route.host.host}:${route.host.wss_port}` : 'unknown'}`,
      `route=${route ? formatRoute(route.proxyUrl) : 'unknown'}`,
      `pingRtt=${this.pingRttMs ?? 'unknown'}ms`,
      `missedPongs=${this.consecutiveMissedPongs}`,
      `inactivity=${inactivityMs}ms`,
      `lastPong=${formatDiagnosticTime(this.lastPongAt)}`,
      `lastHeartbeatSent=${formatDiagnosticTime(this.lastHeartbeatSentAt)}`,
      `lastHeartbeat=${formatDiagnosticTime(this.lastHeartbeatReplyAt)}`,
      `lastFrame=${formatDiagnosticTime(this.lastFrameAt)}`,
      `lastDanmaku=${formatDiagnosticTime(this.lastDanmakuAt)}`
    ].join(' ');
  }

  private writeDiagnostic(message: string): void {
    this.log(`[${new Date(this.now()).toISOString()}] [弹幕] ${message}`);
  }

  private resetTransport(): void {
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = undefined;
    this.connectionAttemptGeneration += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearSocketTimers();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.close();
    }
  }

  private clearSocketTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.transportPingTimer) {
      clearInterval(this.transportPingTimer);
      this.transportPingTimer = undefined;
    }
    if (this.healthyConnectionTimer) {
      clearTimeout(this.healthyConnectionTimer);
      this.healthyConnectionTimer = undefined;
    }
    this.resetBusinessHealth();
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = undefined;
    }
  }
}

function connectWebSocket(url: string, proxyUrl: string | null, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('弹幕服务器连接已取消'));
      return;
    }
    const proxyAgent = proxyUrl
      ? (new HttpsProxyAgent(proxyUrl) as unknown as ClientOptions['agent'])
      : undefined;
    const socket = new WebSocket(url, {
      agent: proxyAgent,
      origin: 'https://live.bilibili.com',
      headers: { 'user-agent': USER_AGENT },
      perMessageDeflate: false,
      handshakeTimeout: CONNECT_TIMEOUT_MS
    });
    const timeout = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error('弹幕服务器连接超时'));
    }, CONNECT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('open', handleOpen);
      socket.off('error', handleError);
      signal?.removeEventListener('abort', handleAbort);
    };
    const handleOpen = () => {
      cleanup();
      resolve(socket);
    };
    const handleError = (error: Error) => {
      cleanup();
      socket.terminate();
      reject(error);
    };
    const handleAbort = () => {
      cleanup();
      socket.once('error', () => undefined);
      socket.terminate();
      reject(new Error('弹幕服务器连接已取消'));
    };
    socket.once('open', handleOpen);
    socket.once('error', handleError);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function getWebSocketProxyCandidates(proxy: ResolvedProxy): Array<string | null> {
  if (proxy.mode === 'off') {
    return [null];
  }
  if (proxy.mode === 'manual') {
    return [proxy.url];
  }

  const candidates: Array<string | null> = proxy.url ? [proxy.url] : [null];
  candidates.push(...getAutoLocalProxyUrls());
  if (proxy.url) {
    candidates.push(null);
  }
  return [...new Set(candidates)];
}

function formatRoute(proxyUrl: string | null): string {
  if (!proxyUrl) {
    return '直连';
  }
  try {
    const url = new URL(proxyUrl);
    return `代理(${url.protocol}//${url.host})`;
  } catch {
    return '代理';
  }
}

function formatDiagnosticTime(value: number | undefined): string {
  return value === undefined ? 'never' : new Date(value).toISOString();
}

function createTrafficWindow(startedAt: number): DanmakuTrafficWindow {
  return {
    startedAt,
    frames: 0,
    bytes: 0,
    packets: 0,
    messagePackets: 0,
    danmaku: 0,
    superChats: 0,
    otherCommands: 0,
    decodeErrors: 0,
    commandErrors: 0,
    commands: new Map()
  };
}

function getDiagnosticCommandName(command: unknown): string {
  if (!isRecord(command) || typeof command.cmd !== 'string' || !command.cmd) {
    return 'invalid';
  }
  return command.cmd.split(':', 1)[0] || 'unknown';
}

function normalizeRoomId(value: string): string | null {
  const roomId = value.trim();
  return /^[1-9]\d*$/.test(roomId) ? roomId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
