import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BilibiliDanmakuSession, DanmakuSessionEvent } from '../danmakuClient';
import { DanmakuOperation, DanmakuProtocolVersion, encodeDanmakuPacket } from '../danmakuProtocol';
import { FetchLike, ResolvedProxy } from '../network';

interface FakeSocket {
  readyState: number;
  ping(): void;
  terminate(): void;
}

interface DanmakuSessionInternals {
  socket?: FakeSocket;
  lastSocketError?: string;
  routeCursor: number;
  generation: number;
  connectionAttemptGeneration: number;
  manualStop: boolean;
  reconnectTimer?: NodeJS.Timeout;
  transportPingTimer?: NodeJS.Timeout;
  expectedTransportCheckAt?: number;
  connectedAt?: number;
  lastFrameAt?: number;
  lastHeartbeatReplyAt?: number;
  consecutiveMissedPongs: number;
  lastDanmakuStarvationRotationAt?: number;
  handleSocketPong(socket: FakeSocket): void;
  handleSocketMessage(socket: FakeSocket, data: Buffer): void;
  checkTransportAlive(socket: FakeSocket): void;
  openSocket(info: {
    roomId: number;
    token: string;
    hosts: Array<{ host: string; wss_port: number }>;
  }, signal?: AbortSignal, attemptGeneration?: number): Promise<FakeSocket>;
  bindSocket(socket: unknown, generation: number, attemptGeneration: number): void;
}

const proxy: ResolvedProxy = { mode: 'off', url: null, source: 'none' };
const unusedFetch: FetchLike = async () => {
  throw new Error('unused in unit test');
};

function createSession(
  now: () => number = Date.now,
  options: {
    connectSocket?: (url: string, proxyUrl: string | null, signal?: AbortSignal) => Promise<unknown>;
    fetchImpl?: FetchLike;
    log?: (message: string) => void;
    proxy?: ResolvedProxy;
  } = {}
): BilibiliDanmakuSession {
  return new BilibiliDanmakuSession(options.fetchImpl ?? unusedFetch, () => options.proxy ?? proxy, {
    now,
    log: options.log,
    connectSocket: options.connectSocket as never
  });
}

function createMessagePacket(content: string, sentAt?: number): Buffer {
  const metadata: unknown[] = [0, 1, 25, 16_777_215];
  if (sentAt !== undefined) {
    metadata[4] = Math.floor(sentAt / 1000);
  }
  return encodeDanmakuPacket(
    DanmakuOperation.Message,
    JSON.stringify({ cmd: 'DANMU_MSG', info: [metadata, content, [123, 'tester', 0], []] }),
    DanmakuProtocolVersion.Json
  );
}

function createOtherCommandPacket(command = 'INTERACT_WORD_V2'): Buffer {
  return encodeDanmakuPacket(
    DanmakuOperation.Message,
    JSON.stringify({ cmd: command, data: {} }),
    DanmakuProtocolVersion.Json
  );
}

function createHeartbeatReply(popularity = 1): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(popularity, 0);
  return encodeDanmakuPacket(DanmakuOperation.HeartbeatReply, body);
}

class LifecycleFakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Buffer[] = [];

  send(data: Buffer): void {
    this.sent.push(data);
  }

  ping(): void {}

  terminate(): void {
    this.readyState = 3;
    this.emit('close', 1006, Buffer.alloc(0));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }
}

test('danmaku session keeps later commands when one command in the frame is malformed', () => {
  const session = createSession();
  const internals = session as unknown as DanmakuSessionInternals;
  const received: string[] = [];
  const unsubscribe = session.onDidEvent((event: DanmakuSessionEvent) => {
    if (event.type === 'message') {
      received.push(event.message.content);
    }
  });
  const frame = Buffer.concat([
    createMessagePacket('first'),
    encodeDanmakuPacket(DanmakuOperation.Message, '{invalid-json', DanmakuProtocolVersion.Json),
    createMessagePacket('third')
  ]);

  const socket: FakeSocket = { readyState: 1, ping() {}, terminate() {} };
  internals.socket = socket;
  internals.handleSocketMessage(socket, frame);

  assert.deepEqual(received, ['first', 'third']);
  internals.socket = undefined;
  unsubscribe();
  session.dispose();
});

test('danmaku transport probe keeps a quiet connection alive without pong while application heartbeats continue', () => {
  let now = 0;
  const session = createSession(() => now);
  const internals = session as unknown as DanmakuSessionInternals;
  let pings = 0;
  let terminations = 0;
  const socket: FakeSocket = {
    readyState: 1,
    ping: () => {
      pings += 1;
    },
    terminate: () => {
      terminations += 1;
    }
  };
  internals.socket = socket;
  internals.connectedAt = now;
  internals.lastFrameAt = now;

  for (let elapsed = 10_000; elapsed <= 90_000; elapsed += 10_000) {
    now = elapsed;
    if (elapsed % 30_000 === 0) {
      internals.handleSocketMessage(socket, createHeartbeatReply());
    }
    internals.checkTransportAlive(socket);
    assert.equal(terminations, 0);
  }

  assert.equal(pings, 9);
  assert.equal(internals.lastHeartbeatReplyAt, 90_000);
  assert.ok(internals.consecutiveMissedPongs >= 8);

  for (const elapsed of [100_000, 110_000, 120_000, 130_000]) {
    now = elapsed;
    internals.checkTransportAlive(socket);
    assert.equal(terminations, 0);
  }
  now = 140_000;
  internals.checkTransportAlive(socket);
  assert.equal(terminations, 1);
  assert.match(internals.lastSocketError ?? '', /45 秒未收到入站数据/);

  internals.socket = undefined;
  session.dispose();
});

test('danmaku transport probe does not blame the network after an extension host event-loop stall', () => {
  let now = 10_000;
  const logs: string[] = [];
  const session = createSession(() => now, { log: (message) => logs.push(message) });
  const internals = session as unknown as DanmakuSessionInternals;
  let pings = 0;
  let terminations = 0;
  const socket: FakeSocket = {
    readyState: 1,
    ping: () => {
      pings += 1;
    },
    terminate: () => {
      terminations += 1;
    }
  };
  internals.socket = socket;
  internals.connectedAt = now;
  internals.lastFrameAt = now;
  internals.expectedTransportCheckAt = now;
  now += 6_000;

  internals.checkTransportAlive(socket);

  assert.equal(pings, 1);
  assert.equal(terminations, 0);
  assert.ok(logs.some((line) => line.includes('事件循环延迟')));

  internals.handleSocketMessage(
    socket,
    Buffer.concat([
      createMessagePacket('locally-delayed-first', now - 15_000),
      createMessagePacket('locally-delayed-second', now - 14_000)
    ])
  );
  assert.equal(terminations, 0);
  assert.ok(logs.some((line) => line.includes('本批不轮换线路')));
  internals.socket = undefined;
  session.dispose();
});

test('danmaku business health rotates a route when pong is healthy but messages arrive late in a batch', () => {
  const now = 1_700_000_020_000;
  const logs: string[] = [];
  const session = createSession(() => now, { log: (message) => logs.push(message) });
  const internals = session as unknown as DanmakuSessionInternals;
  let pings = 0;
  let terminations = 0;
  const socket: FakeSocket = {
    readyState: 1,
    ping: () => {
      pings += 1;
    },
    terminate: () => {
      terminations += 1;
    }
  };
  internals.socket = socket;

  internals.handleSocketPong(socket);
  internals.checkTransportAlive(socket);
  assert.equal(pings, 1);
  assert.equal(terminations, 0);

  internals.handleSocketMessage(
    socket,
    Buffer.concat([
      createMessagePacket('delayed-first', now - 15_000),
      createMessagePacket('delayed-second', now - 14_000)
    ])
  );

  assert.equal(terminations, 1);
  assert.match(internals.lastSocketError ?? '', /业务消息延迟/);
  assert.ok(logs.some((line) => line.includes('业务流退化')));
  internals.socket = undefined;
  session.dispose();
});

test('danmaku socket routes continue from the next host after a successful connection', async () => {
  const attemptedUrls: string[] = [];
  const fakeSocket = { readyState: 1, ping() {}, terminate() {} };
  const session = createSession(Date.now, {
    connectSocket: async (url) => {
      attemptedUrls.push(url);
      return fakeSocket;
    }
  });
  const internals = session as unknown as DanmakuSessionInternals;
  const info = {
    roomId: 6,
    token: 'token',
    hosts: [
      { host: 'host-a.example', wss_port: 443 },
      { host: 'host-b.example', wss_port: 2245 }
    ]
  };

  await internals.openSocket(info);
  await internals.openSocket(info);

  assert.deepEqual(attemptedUrls, [
    'wss://host-a.example:443/sub',
    'wss://host-b.example:2245/sub'
  ]);
  assert.equal(internals.routeCursor, 0);
  session.dispose();
});

test('danmaku socket attempts only one route before yielding to reconnect backoff', async () => {
  const attemptedUrls: string[] = [];
  const session = createSession(Date.now, {
    connectSocket: async (url) => {
      attemptedUrls.push(url);
      throw new Error('route unavailable');
    }
  });
  const internals = session as unknown as DanmakuSessionInternals;
  const info = {
    roomId: 6,
    token: 'token',
    hosts: [
      { host: 'host-a.example', wss_port: 443 },
      { host: 'host-b.example', wss_port: 2245 }
    ]
  };

  await assert.rejects(internals.openSocket(info), /host-a\.example/);
  assert.deepEqual(attemptedUrls, ['wss://host-a.example:443/sub']);
  assert.equal(internals.routeCursor, 1);

  await assert.rejects(internals.openSocket(info), /host-b\.example/);
  assert.deepEqual(attemptedUrls, [
    'wss://host-a.example:443/sub',
    'wss://host-b.example:2245/sub'
  ]);
  assert.equal(internals.routeCursor, 0);
  session.dispose();
});

test('danmaku auto routes rotate hosts before falling back to another proxy candidate', async () => {
  const attempts: Array<{ url: string; proxyUrl: string | null }> = [];
  const fakeSocket = { readyState: 1, ping() {}, terminate() {} };
  const preferredProxy = 'http://127.0.0.1:7890';
  const session = createSession(Date.now, {
    proxy: { mode: 'auto', url: preferredProxy, source: 'vscode' },
    connectSocket: async (url, proxyUrl) => {
      attempts.push({ url, proxyUrl });
      return fakeSocket;
    }
  });
  const internals = session as unknown as DanmakuSessionInternals;
  const info = {
    roomId: 6,
    token: 'token',
    hosts: [
      { host: 'host-a.example', wss_port: 443 },
      { host: 'host-b.example', wss_port: 2245 }
    ]
  };

  await internals.openSocket(info);
  await internals.openSocket(info);

  assert.deepEqual(attempts, [
    { url: 'wss://host-a.example:443/sub', proxyUrl: preferredProxy },
    { url: 'wss://host-b.example:2245/sub', proxyUrl: preferredProxy }
  ]);
  session.dispose();
});

test('danmaku websocket handshake observes lifecycle cancellation', async () => {
  let receivedSignal: AbortSignal | undefined;
  const session = createSession(Date.now, {
    connectSocket: async (_url, _proxyUrl, signal) =>
      new Promise<unknown>((_resolve, reject) => {
        receivedSignal = signal;
        signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      })
  });
  const internals = session as unknown as DanmakuSessionInternals;
  const controller = new AbortController();
  const pending = internals.openSocket(
    { roomId: 6, token: 'token', hosts: [{ host: 'host-a.example', wss_port: 443 }] },
    controller.signal
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(receivedSignal, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  session.dispose();
});

test('danmaku room switch aborts the previous initialization request', async () => {
  const signals: AbortSignal[] = [];
  const fetchImpl: FetchLike = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  const session = createSession(Date.now, { fetchImpl });

  session.connect('1');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const firstSignal = signals[0];
  assert.ok(firstSignal);
  assert.equal(firstSignal.aborted, false);

  session.connect('2');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstSignal.aborted, true);
  assert.equal(signals.length, 2);

  session.disconnect();
  assert.equal(signals[1]?.aborted, true);
});

test('danmaku retries a transient initialization failure', async () => {
  const session = createSession(Date.now, {
    fetchImpl: async () => {
      throw new Error('temporary network failure');
    }
  });

  session.connect('1');
  await new Promise<void>((resolve) => setImmediate(resolve));

  const snapshot = session.getSnapshot();
  assert.equal(snapshot.status, 'reconnecting');
  assert.equal(snapshot.reconnectAttempt, 1);
  assert.match(snapshot.error ?? '', /temporary network failure/);
  session.disconnect();
});

test('danmaku does not retry a room id rejected as invalid', async () => {
  const session = createSession(Date.now, {
    fetchImpl: async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ code: -400, message: 'room not found' })
      }) as Response
  });

  session.connect('1');
  await new Promise<void>((resolve) => setImmediate(resolve));

  const snapshot = session.getSnapshot();
  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.reconnectAttempt, 0);
  assert.match(snapshot.error ?? '', /room not found/);
  session.disconnect();
});

test('danmaku ignores a stale socket close after a newer attempt becomes active', () => {
  const session = createSession();
  const internals = session as unknown as DanmakuSessionInternals;
  internals.manualStop = false;
  internals.generation = 7;
  internals.connectionAttemptGeneration = 11;
  const staleSocket = new LifecycleFakeSocket();
  internals.bindSocket(staleSocket, 7, 11);
  const transportTimer = internals.transportPingTimer;

  const activeSocket = new LifecycleFakeSocket();
  internals.socket = activeSocket;
  internals.connectionAttemptGeneration = 12;
  staleSocket.emit('close', 1006, Buffer.from('late close'));

  assert.equal(internals.socket, activeSocket);
  assert.equal(internals.transportPingTimer, transportTimer);
  assert.equal(internals.reconnectTimer, undefined);
  session.dispose();
});

test('danmaku traffic diagnostics distinguish transport, protocol, and parsed message activity', () => {
  let now = 1_700_000_000_000;
  const logs: string[] = [];
  const session = createSession(() => now, { log: (message) => logs.push(message) });
  const internals = session as unknown as DanmakuSessionInternals;
  const socket: FakeSocket = { readyState: 1, ping() {}, terminate() {} };
  internals.socket = socket;
  internals.connectedAt = now;
  internals.handleSocketMessage(
    socket,
    Buffer.concat([
      createMessagePacket('first', now - 1_000),
      encodeDanmakuPacket(
        DanmakuOperation.Message,
        JSON.stringify({ cmd: 'SEND_GIFT', data: {} }),
        DanmakuProtocolVersion.Json
      ),
      createMessagePacket('second', now - 2_000)
    ])
  );
  now += 10_000;

  internals.checkTransportAlive(socket);

  const trafficLog = logs.find((line) => line.includes('流量窗口')) ?? '';
  assert.match(trafficLog, /frames=1/);
  assert.match(trafficLog, /messagePackets=3/);
  assert.match(trafficLog, /danmaku=2/);
  assert.match(trafficLog, /other=1/);
  assert.match(trafficLog, /commands=DANMU_MSG:2,SEND_GIFT:1/);
  assert.doesNotMatch(trafficLog, /first|second/);
  internals.socket = undefined;
  session.dispose();
});

test('danmaku business health rotates a route when text messages starve while other commands continue', () => {
  let now = 1_700_000_000_000;
  const logs: string[] = [];
  const session = createSession(() => now, { log: (message) => logs.push(message) });
  const internals = session as unknown as DanmakuSessionInternals;
  let terminations = 0;
  const socket: FakeSocket = {
    readyState: 1,
    ping() {},
    terminate: () => {
      terminations += 1;
    }
  };
  internals.socket = socket;
  internals.connectedAt = now;
  internals.handleSocketMessage(socket, createMessagePacket('seed', now));
  internals.checkTransportAlive(socket);

  for (let window = 1; window <= 3; window += 1) {
    internals.handleSocketMessage(
      socket,
      Buffer.concat(Array.from({ length: 4 }, () => createOtherCommandPacket()))
    );
    now += 10_000;
    internals.checkTransportAlive(socket);
    assert.equal(terminations, window === 3 ? 1 : 0);
  }

  assert.match(internals.lastSocketError ?? '', /选择性中断/);
  assert.ok(logs.some((line) => line.includes('文本弹幕选择性饥饿，将轮换线路')));
  assert.ok(logs.some((line) => line.includes('windows=3') && line.includes('other=12')));
  internals.socket = undefined;
  session.dispose();
});

test('danmaku starvation detection is suppressed after an extension host event-loop stall', () => {
  let now = 1_700_000_000_000;
  const logs: string[] = [];
  const session = createSession(() => now, { log: (message) => logs.push(message) });
  const internals = session as unknown as DanmakuSessionInternals;
  let terminations = 0;
  const socket: FakeSocket = {
    readyState: 1,
    ping() {},
    terminate: () => {
      terminations += 1;
    }
  };
  internals.socket = socket;
  internals.connectedAt = now;
  internals.handleSocketMessage(socket, createMessagePacket('seed', now));
  internals.checkTransportAlive(socket);
  internals.handleSocketMessage(
    socket,
    Buffer.concat(Array.from({ length: 4 }, () => createOtherCommandPacket()))
  );
  now += 10_000;
  internals.checkTransportAlive(socket);

  internals.handleSocketMessage(
    socket,
    Buffer.concat(Array.from({ length: 4 }, () => createOtherCommandPacket()))
  );
  now += 16_000;
  internals.checkTransportAlive(socket);
  for (let window = 0; window < 2; window += 1) {
    internals.handleSocketMessage(
      socket,
      Buffer.concat(Array.from({ length: 4 }, () => createOtherCommandPacket()))
    );
    now += 10_000;
    internals.checkTransportAlive(socket);
  }

  assert.equal(terminations, 0);
  assert.ok(logs.some((line) => line.includes('清除文本弹幕饥饿观察窗口')));
  internals.socket = undefined;
  session.dispose();
});

test('danmaku business health does not rotate after a single naturally quiet text window', () => {
  let now = 1_700_000_000_000;
  const session = createSession(() => now);
  const internals = session as unknown as DanmakuSessionInternals;
  let terminations = 0;
  const socket: FakeSocket = {
    readyState: 1,
    ping() {},
    terminate: () => {
      terminations += 1;
    }
  };
  internals.socket = socket;
  internals.connectedAt = now;
  internals.handleSocketMessage(socket, createMessagePacket('seed', now));
  internals.checkTransportAlive(socket);
  internals.handleSocketMessage(
    socket,
    Buffer.concat(Array.from({ length: 20 }, () => createOtherCommandPacket()))
  );
  now += 10_000;

  internals.checkTransportAlive(socket);

  assert.equal(terminations, 0);
  internals.socket = undefined;
  session.dispose();
});

test('danmaku business health requires a text message baseline before detecting starvation', () => {
  let now = 1_700_000_000_000;
  const session = createSession(() => now);
  const internals = session as unknown as DanmakuSessionInternals;
  let terminations = 0;
  const socket: FakeSocket = {
    readyState: 1,
    ping() {},
    terminate: () => {
      terminations += 1;
    }
  };
  internals.socket = socket;
  internals.connectedAt = now;

  for (let window = 0; window < 4; window += 1) {
    internals.handleSocketMessage(
      socket,
      Buffer.concat(Array.from({ length: 4 }, () => createOtherCommandPacket()))
    );
    now += 10_000;
    internals.checkTransportAlive(socket);
  }

  assert.equal(terminations, 0);
  internals.socket = undefined;
  session.dispose();
});

test('danmaku business health resets starvation evidence when a text message arrives', () => {
  let now = 1_700_000_000_000;
  const session = createSession(() => now);
  const internals = session as unknown as DanmakuSessionInternals;
  let terminations = 0;
  const socket: FakeSocket = {
    readyState: 1,
    ping() {},
    terminate: () => {
      terminations += 1;
    }
  };
  internals.socket = socket;
  internals.connectedAt = now;
  internals.handleSocketMessage(socket, createMessagePacket('seed', now));
  internals.checkTransportAlive(socket);

  for (let window = 0; window < 2; window += 1) {
    internals.handleSocketMessage(
      socket,
      Buffer.concat(Array.from({ length: 4 }, () => createOtherCommandPacket()))
    );
    now += 10_000;
    internals.checkTransportAlive(socket);
  }
  internals.handleSocketMessage(socket, createMessagePacket('recovered', now));
  for (let window = 0; window < 2; window += 1) {
    internals.handleSocketMessage(
      socket,
      Buffer.concat(Array.from({ length: 4 }, () => createOtherCommandPacket()))
    );
    now += 10_000;
    internals.checkTransportAlive(socket);
  }

  assert.equal(terminations, 0);
  internals.socket = undefined;
  session.dispose();
});

test('danmaku starvation route rotation observes a sixty second cooldown', () => {
  let now = 1_700_000_000_000;
  const logs: string[] = [];
  const session = createSession(() => now, { log: (message) => logs.push(message) });
  const internals = session as unknown as DanmakuSessionInternals;
  let terminations = 0;
  const socket: FakeSocket = {
    readyState: 1,
    ping() {},
    terminate: () => {
      terminations += 1;
    }
  };
  internals.socket = socket;
  internals.connectedAt = now;
  internals.lastDanmakuStarvationRotationAt = now;
  internals.handleSocketMessage(socket, createMessagePacket('seed', now));
  internals.checkTransportAlive(socket);

  for (let window = 1; window <= 6; window += 1) {
    internals.handleSocketMessage(
      socket,
      Buffer.concat(Array.from({ length: 4 }, () => createOtherCommandPacket()))
    );
    now += 10_000;
    internals.checkTransportAlive(socket);
    assert.equal(terminations, window === 6 ? 1 : 0);
  }

  assert.ok(logs.some((line) => line.includes('线路轮换仍在冷却期')));
  internals.socket = undefined;
  session.dispose();
});
