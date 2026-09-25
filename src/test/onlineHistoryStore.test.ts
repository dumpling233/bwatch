import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ONLINE_HISTORY_STORAGE_KEY,
  ONLINE_HISTORY_RECENT_WINDOW_MS,
  OnlineHistoryStore,
  MementoLike
} from '../onlineHistoryStore';
import { LiveRoomStatus } from '../types';

class FakeMemento implements MementoLike {
  constructor(private readonly values = new Map<string, unknown>()) {}

  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

test('OnlineHistoryStore appends samples and keeps null points', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);

  await store.record([room('100', 99)], 1000);
  const history = await store.record([room('100', null)], 2000);

  assert.deepEqual(history['100'], [
    [1000, 99],
    [2000, null]
  ]);
});

test('OnlineHistoryStore identifies sessions from positive, zero, and null samples', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  const firstStart = 1000;

  await store.record([room('100', 10)], firstStart);
  await store.record([room('100', null)], 2000);
  await store.record([room('100', 30)], 3000);
  await store.record([room('100', 0)], 4000);
  await store.record([room('100', 8)], 5000);
  await store.record([room('100', 0)], 6000);

  assert.deepEqual(store.getRoomSessions('100'), [
    { roomId: '100', startMs: 5000, endMs: 5000, durationMs: 0, peakOnline: 8, sampleCount: 1, validSampleCount: 1 },
    { roomId: '100', startMs: firstStart, endMs: 3000, durationMs: 2000, peakOnline: 30, sampleCount: 3, validSampleCount: 2 }
  ]);
});

test('OnlineHistoryStore returns no sessions for empty, zero, or null-only history', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  await store.record([room('100', 0)], 1000);
  await store.record([room('100', null)], 2000);
  assert.deepEqual(store.getRoomSessions('100'), []);
  assert.deepEqual(store.getRoomSessions('missing'), []);
});

test('OnlineHistoryStore persists samples to local room files', async (t) => {
  const storageRootPath = createTempDir(t);
  const firstStore = new OnlineHistoryStore(new FakeMemento(), storageRootPath);

  await firstStore.record([room('100', 99)], 1000);
  await firstStore.flush();

  const secondStore = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  assert.deepEqual(secondStore.getHistoryForRooms(['100'], 2000), {
    '100': [[1000, 99]]
  });
});

test('OnlineHistoryStore uses stored anchor names for historical queries', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  const timestamp = new Date(2026, 7, 13, 8, 30, 0, 0).getTime();

  await store.record([room('100', 99, '主播甲')], timestamp);

  const history = store.queryDateHistory('2026-08-13', 8 * 60, 9 * 60);
  assert.deepEqual(history.rooms, [
    {
      roomId: '100',
      anchorName: '主播甲',
      points: [[timestamp, 99]]
    }
  ]);
});

test('OnlineHistoryStore restores stored anchor names from local room files', async (t) => {
  const storageRootPath = createTempDir(t);
  const timestamp = new Date(2026, 7, 13, 8, 30, 0, 0).getTime();
  const firstStore = new OnlineHistoryStore(new FakeMemento(), storageRootPath);

  await firstStore.record([room('100', 99, '主播甲')], timestamp);
  await firstStore.flush();

  const secondStore = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  const history = secondStore.queryDateHistory('2026-08-13', 8 * 60, 9 * 60);
  assert.deepEqual(history.rooms, [
    {
      roomId: '100',
      anchorName: '主播甲',
      points: [[timestamp, 99]]
    }
  ]);
});

test('OnlineHistoryStore does not overwrite stored anchor names with fallback values', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  const firstTimestamp = new Date(2026, 7, 13, 8, 30, 0, 0).getTime();
  const secondTimestamp = new Date(2026, 7, 13, 8, 45, 0, 0).getTime();

  await store.record([room('100', 99, '主播甲')], firstTimestamp);
  await store.record([room('100', null, '-')], secondTimestamp);

  const history = store.queryDateHistory('2026-08-13', 8 * 60, 9 * 60);
  assert.equal(history.rooms[0].anchorName, '主播甲');
});

test('OnlineHistoryStore keeps long-term files while recent snapshots are limited to 24 hours', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  const now = 2 * ONLINE_HISTORY_RECENT_WINDOW_MS;
  const oldTimestamp = now - ONLINE_HISTORY_RECENT_WINDOW_MS - 1;

  await store.record([room('100', 1)], oldTimestamp);
  const recentHistory = await store.record([room('100', 2)], now);

  assert.deepEqual(recentHistory['100'], [[now, 2]]);
  assert.deepEqual(store.getRoomHistory('100'), [
    [oldTimestamp, 1],
    [now, 2]
  ]);
});

test('OnlineHistoryStore keeps long-term queries complete after trimming the memory projection', (t) => {
  const storageRootPath = createTempDir(t);
  const historyDirPath = path.join(storageRootPath, 'online-history');
  fs.mkdirSync(historyDirPath, { recursive: true });
  const nowMs = Date.now();
  const points = Array.from({ length: 12_050 }, (_, index) => [
    nowMs - (12_049 - index) * 60_000,
    index % 2
  ] as [number, number]);
  fs.writeFileSync(
    path.join(historyDirPath, '100.json'),
    JSON.stringify({ version: 2, anchorName: '主播', points }),
    'utf8'
  );

  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  const completeHistory = store.getRoomHistory('100');
  const recentHistory = store.getHistory()['100'] ?? [];
  const dateSummary = store.getAvailableDates().reduce((total, item) => total + item.pointCount, 0);

  assert.equal(completeHistory.length, points.length);
  assert.ok(recentHistory.length < completeHistory.length);
  assert.ok(recentHistory.length > 0);
  assert.equal(dateSummary, points.length);
});

test('OnlineHistoryStore filters inactive rooms without deleting their long-term history', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);

  await store.record([room('100', 1), room('200', 2)], 1000);
  const visibleHistory = await store.pruneRooms(['200'], 2000);

  assert.equal(visibleHistory['100'], undefined);
  assert.deepEqual(visibleHistory['200'], [[1000, 2]]);
  assert.deepEqual(store.getRoomHistory('100'), [[1000, 1]]);
});

test('OnlineHistoryStore keeps history when a room is deleted from monitoring', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);

  await store.record([room('100', 1), room('200', 2)], 1000);
  await store.deleteRoom('100');

  assert.deepEqual(store.getRoomHistory('100'), [[1000, 1]]);
});

test('OnlineHistoryStore migrates valid globalState history into local storage', (t) => {
  const storageRootPath = createTempDir(t);
  const memento = new FakeMemento(
    new Map([
      [
        ONLINE_HISTORY_STORAGE_KEY,
        {
          '100': [
            [1000, 10],
            [2000, null],
            [3000, -1],
            ['bad', 20]
          ],
          invalid: [[1000, 1]]
        }
      ]
    ])
  );

  const migratedStore = new OnlineHistoryStore(memento, storageRootPath);
  const restoredStore = new OnlineHistoryStore(new FakeMemento(), storageRootPath);

  assert.deepEqual(migratedStore.getHistoryForRooms(['100'], 3000), {
    '100': [
      [1000, 10],
      [2000, null]
    ]
  });
  assert.deepEqual(restoredStore.getHistoryForRooms(['100'], 3000), {
    '100': [
      [1000, 10],
      [2000, null]
    ]
  });
});

test('OnlineHistoryStore keeps migration pending when its checkpoint cannot be written', (t) => {
  const storageRootPath = createTempDir(t);
  fs.writeFileSync(path.join(storageRootPath, 'online-history'), 'blocked', 'utf8');
  const memento = new FakeMemento(new Map([
    [ONLINE_HISTORY_STORAGE_KEY, { '100': [[1000, 10]] }]
  ]));

  const store = new OnlineHistoryStore(memento, storageRootPath);

  assert.equal(memento.get('bwatch.onlineHistory.migrated.v2', false), false);
  assert.equal(store.getPersistenceStatus().state, 'degraded');
  assert.deepEqual(store.getRoomHistory('100'), [[1000, 10]]);
});

test('OnlineHistoryStore lists available local dates', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  const firstDay = new Date(2026, 7, 12, 10, 0, 0, 0).getTime();
  const secondDay = new Date(2026, 7, 13, 10, 0, 0, 0).getTime();

  await store.record([room('100', 10)], firstDay);
  await store.record([room('100', 20), room('200', 30)], secondDay);

  assert.deepEqual(store.getAvailableDates(), [
    {
      date: '2026-08-12',
      roomIds: ['100'],
      pointCount: 1
    },
    {
      date: '2026-08-13',
      roomIds: ['100', '200'],
      pointCount: 2
    }
  ]);
});

test('OnlineHistoryStore queries one local date time range', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  const inRange = new Date(2026, 7, 13, 8, 30, 0, 0).getTime();
  const outOfRange = new Date(2026, 7, 13, 9, 31, 0, 0).getTime();

  await store.record([room('100', 10)], inRange);
  await store.record([room('100', 20), room('200', 0)], outOfRange);

  const history = store.queryDateHistory('2026-08-13', 8 * 60, 9 * 60, { '100': '主播甲' });

  assert.equal(history.date, '2026-08-13');
  assert.equal(history.startMs, new Date(2026, 7, 13, 8, 0, 0, 0).getTime());
  assert.equal(history.endMs, new Date(2026, 7, 13, 9, 0, 59, 999).getTime());
  assert.deepEqual(history.rooms, [
    {
      roomId: '100',
      anchorName: '主播甲',
      points: [[inRange, 10]]
    }
  ]);
});

test('OnlineHistoryStore async history queries match synchronous results without blocking callers', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  const firstPoint = new Date(2026, 7, 13, 8, 30, 0, 0).getTime();
  const secondPoint = new Date(2026, 7, 13, 8, 31, 0, 0).getTime();

  await store.record([room('100', 10, '主播甲')], firstPoint);
  await store.record([room('100', null, '主播甲')], secondPoint);
  await store.record([room('100', 0, '主播甲')], secondPoint + 60_000);

  assert.deepEqual(await store.getAvailableDatesAsync(), store.getAvailableDates());
  assert.deepEqual(
    await store.queryDateRangeHistoryAsync(['2026-08-13'], 8 * 60, 9 * 60),
    store.queryDateRangeHistory(['2026-08-13'], 8 * 60, 9 * 60)
  );
  assert.deepEqual(await store.getRoomSessionsAsync('100'), store.getRoomSessions('100'));
});

test('OnlineHistoryStore queries two adjacent local dates as one continuous range', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  const firstDayPoint = new Date(2026, 7, 13, 23, 58, 0, 0).getTime();
  const secondDayPoint = new Date(2026, 7, 14, 0, 2, 0, 0).getTime();

  await store.record([room('100', 10, '主播甲')], firstDayPoint);
  await store.record([room('100', 20, '主播甲')], secondDayPoint);

  const history = store.queryDateRangeHistory(['2026-08-13', '2026-08-14'], 23 * 60, 24 * 60 + 5);

  assert.deepEqual(history.dates, ['2026-08-13', '2026-08-14']);
  assert.equal(history.startMs, new Date(2026, 7, 13, 23, 0, 0, 0).getTime());
  assert.equal(history.endMs, new Date(2026, 7, 14, 0, 5, 59, 999).getTime());
  assert.equal(history.boundaryMs, new Date(2026, 7, 14, 0, 0, 0, 0).getTime());
  assert.deepEqual(history.rooms[0].points, [[firstDayPoint, 10], [secondDayPoint, 20]]);
});

test('OnlineHistoryStore rejects ranges longer than two days or with non-adjacent dates', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);

  assert.deepEqual(store.queryDateRangeHistory(['2026-08-13', '2026-08-15']).dates, []);
  assert.deepEqual(store.queryDateRangeHistory(['2026-08-13', '2026-08-14', '2026-08-15']).dates, []);
});


test('OnlineHistoryStore recovers WAL records with duplicate, out-of-order, and torn tail', async (t) => {
  const storageRootPath = createTempDir(t);
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  await store.record([room('100', 10)], 1000);
  await store.record([room('100', null)], 2000);
  await store.flush();

  const walPath = path.join(storageRootPath, 'online-history', '100.wal');
  const lines = fs.readFileSync(walPath, 'utf8').trim().split(String.fromCharCode(10));
  assert.equal(lines.length, 2);
  fs.writeFileSync(walPath, [lines[1], lines[0], lines[1], '{"version":1'].join(String.fromCharCode(10)) + String.fromCharCode(10));

  const restored = new OnlineHistoryStore(new FakeMemento(), storageRootPath);
  assert.deepEqual(restored.getRoomHistory('100'), [
    [1000, 10],
    [2000, null]
  ]);
  assert.doesNotMatch(fs.readFileSync(walPath, 'utf8'), /\{"version":1$/m);
});

test('OnlineHistoryStore queues samples before the scheduled flush and reports aged writes', async (t) => {
  const store = new OnlineHistoryStore(new FakeMemento(), createTempDir(t));
  await store.record([room('100', 10)], 1000);
  const pending = store.getPersistenceStatus();
  assert.equal(pending.pendingRooms, 1);
  assert.equal(pending.lastPersistedSequence, 0);
  assert.equal(store.getPersistenceStatus(Date.now() + 5_001).state, 'degraded');
  await store.flush();
  assert.equal(store.getPersistenceStatus().pendingRooms, 0);
});

test('OnlineHistoryStore reports a clean persistence queue after flush', async (t) => {
  const store = new OnlineHistoryStore(new FakeMemento(), createTempDir(t));
  await store.record([room('100', 10)], 1000);
  await store.flush();
  const status = store.getPersistenceStatus();
  assert.equal(status.state, 'healthy');
  assert.equal(status.pendingRooms, 0);
  assert.equal(status.enqueuedSequence, status.lastPersistedSequence);
});

test('OnlineHistoryStore isolates one room write failure and retries it after recovery', async (t) => {
  const storageRootPath = createTempDir(t);
  const historyDirPath = path.join(storageRootPath, 'online-history');
  const failedWalPath = path.join(historyDirPath, '100.wal');
  fs.mkdirSync(failedWalPath, { recursive: true });
  const store = new OnlineHistoryStore(new FakeMemento(), storageRootPath);

  await store.record([room('100', 10), room('200', 20)], 1000);
  await assert.rejects(() => store.flush());

  assert.equal(store.getPersistenceStatus().state, 'failed');
  assert.equal(store.getPersistenceStatus().pendingRooms, 1);
  assert.ok(fs.existsSync(path.join(historyDirPath, '200.wal')));

  fs.rmSync(failedWalPath, { recursive: true, force: true });
  await store.flush();

  assert.equal(store.getPersistenceStatus().state, 'healthy');
  assert.equal(store.getPersistenceStatus().pendingRooms, 0);
  assert.ok(fs.existsSync(failedWalPath));
});

function createTempDir(t: TestContext): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bwatch-history-'));
  t.after(() => fs.rmSync(dirPath, { recursive: true, force: true }));
  return dirPath;
}

function room(roomId: string, online: number | null, anchorName = '主播'): LiveRoomStatus {
  return {
    roomId,
    title: `房间 ${roomId}`,
    anchorName,
    fansCount: null,
    status: online === 0 ? 'offline' : 'live',
    online,
    popularity: null,
    guardFleet: null,
    liveStartTime: online === 0 ? null : 1,
    liveDurationText: online === 0 ? '未开播' : '00:01:00',
    lastUpdatedAt: 1000
  };
}
