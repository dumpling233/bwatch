import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BilibiliLiveClient } from '../bilibiliClient';
import { LiveMonitor } from '../liveMonitor';
import { MementoLike, OnlineHistoryStore } from '../onlineHistoryStore';
import { LiveRoomStatus } from '../types';

class FakeClient extends BilibiliLiveClient {
  private index = 0;

  constructor(private readonly batches: LiveRoomStatus[][]) {
    super();
  }

  override async fetchRooms(): Promise<LiveRoomStatus[]> {
    const batch = this.batches[Math.min(this.index, this.batches.length - 1)];
    this.index += 1;
    return batch;
  }
}

class FakeMemento implements MementoLike {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

test('LiveMonitor sends live-start notification only on offline to live transition', async () => {
  const notifications: Array<{ roomId: string; anchorName: string; title: string }> = [];
  const monitor = new LiveMonitor(
    new FakeClient([
      [room('100', 'offline')],
      [room('100', 'live')],
      [room('100', 'live')]
    ]),
    {
      rooms: ['100'],
      groups: [],
      autoRefreshEnabled: false,
      autoRefreshIntervalSeconds: 15,
      liveStartNotificationsEnabled: true
    },
    {
      notifyLiveStart(roomId, anchorName, title) {
        notifications.push({ roomId, anchorName, title });
      }
    }
  );

  await monitor.refresh();
  await monitor.refresh();
  await monitor.refresh();
  monitor.dispose();

  assert.deepEqual(notifications, [{ roomId: '100', anchorName: '主播', title: '房间 100' }]);
});

test('LiveMonitor respects live-start notification switch', async () => {
  const notifications: string[] = [];
  const monitor = new LiveMonitor(
    new FakeClient([[room('100', 'live')]]),
    {
      rooms: ['100'],
      groups: [],
      autoRefreshEnabled: false,
      autoRefreshIntervalSeconds: 15,
      liveStartNotificationsEnabled: false
    },
    {
      notifyLiveStart(roomId) {
        notifications.push(roomId);
      }
    }
  );

  await monitor.refresh();
  monitor.dispose();

  assert.deepEqual(notifications, []);
});

test('LiveMonitor writes online history after refresh and includes it in snapshot', async (t) => {
  const store = new OnlineHistoryStore(new FakeMemento(), createTempDir(t));
  const monitor = new LiveMonitor(
    new FakeClient([[room('100', 'live', 123)]]),
    {
      rooms: ['100'],
      groups: [],
      autoRefreshEnabled: false,
      autoRefreshIntervalSeconds: 15,
      liveStartNotificationsEnabled: false
    },
    {
      notifyLiveStart() {}
    },
    store
  );

  await monitor.refresh();
  const snapshot = monitor.getSnapshot();
  monitor.dispose();

  assert.equal(snapshot.onlineHistory['100'].length, 1);
  assert.equal(snapshot.onlineHistory['100'][0][1], 123);
});

test('LiveMonitor keeps null samples in online history', async (t) => {
  const store = new OnlineHistoryStore(new FakeMemento(), createTempDir(t));
  const monitor = new LiveMonitor(
    new FakeClient([[room('100', 'live', null)]]),
    {
      rooms: ['100'],
      groups: [],
      autoRefreshEnabled: false,
      autoRefreshIntervalSeconds: 15,
      liveStartNotificationsEnabled: false
    },
    {
      notifyLiveStart() {}
    },
    store
  );

  await monitor.refresh();
  const snapshot = monitor.getSnapshot();
  monitor.dispose();

  assert.equal(snapshot.onlineHistory['100'][0][1], null);
});

test('LiveMonitor hides removed room history from snapshot without deleting stored history', async (t) => {
  const store = new OnlineHistoryStore(new FakeMemento(), createTempDir(t));
  const monitor = new LiveMonitor(
    new FakeClient([[room('100', 'live', 12), room('200', 'live', 34)], [room('200', 'live', 35)]]),
    {
      rooms: ['100', '200'],
      groups: [],
      autoRefreshEnabled: false,
      autoRefreshIntervalSeconds: 15,
      liveStartNotificationsEnabled: false
    },
    {
      notifyLiveStart() {}
    },
    store
  );

  await monitor.refresh();
  monitor.updateSettings({
    rooms: ['200'],
    groups: [],
    autoRefreshEnabled: false,
    autoRefreshIntervalSeconds: 15,
    liveStartNotificationsEnabled: false
  });
  await monitor.refresh();
  const snapshot = monitor.getSnapshot();
  monitor.dispose();

  assert.equal(snapshot.onlineHistory['100'], undefined);
  assert.ok(snapshot.onlineHistory['200'].length >= 1);
  assert.deepEqual(store.getRoomHistory('100').map((point) => point[1]), [12]);
});

test('LiveMonitor restores previous room history when a room is re-added', async (t) => {
  const store = new OnlineHistoryStore(new FakeMemento(), createTempDir(t));
  const monitor = new LiveMonitor(
    new FakeClient([[room('100', 'live', 12), room('200', 'live', 34)], [room('100', 'live', 13), room('200', 'live', 35)]]),
    {
      rooms: ['100', '200'],
      groups: [],
      autoRefreshEnabled: false,
      autoRefreshIntervalSeconds: 15,
      liveStartNotificationsEnabled: false
    },
    {
      notifyLiveStart() {}
    },
    store
  );

  await monitor.refresh();
  monitor.updateSettings({
    rooms: ['200'],
    groups: [],
    autoRefreshEnabled: false,
    autoRefreshIntervalSeconds: 15,
    liveStartNotificationsEnabled: false
  });
  monitor.updateSettings({
    rooms: ['100', '200'],
    groups: [],
    autoRefreshEnabled: false,
    autoRefreshIntervalSeconds: 15,
    liveStartNotificationsEnabled: false
  });
  const snapshot = monitor.getSnapshot();
  monitor.dispose();

  assert.ok(snapshot.onlineHistory['100'].length >= 1);
  assert.equal(snapshot.onlineHistory['100'][0][1], 12);
});

function createTempDir(t: TestContext): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bwatch-monitor-history-'));
  t.after(() => fs.rmSync(dirPath, { recursive: true, force: true }));
  return dirPath;
}

function room(roomId: string, status: 'live' | 'offline', online?: number | null): LiveRoomStatus {
  return {
    roomId,
    title: `房间 ${roomId}`,
    anchorName: '主播',
    fansCount: null,
    status,
    online: online === undefined ? (status === 'live' ? 100 : 0) : online,
    popularity: status === 'live' ? 1000 : 0,
    guardFleet: null,
    liveStartTime: status === 'live' ? 1 : null,
    liveDurationText: status === 'live' ? '1分钟0秒' : '未开播',
    lastUpdatedAt: 1000
  };
}
