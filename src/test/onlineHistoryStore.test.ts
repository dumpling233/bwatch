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

test('OnlineHistoryStore persists samples to local room files', async (t) => {
  const storageRootPath = createTempDir(t);
  const firstStore = new OnlineHistoryStore(new FakeMemento(), storageRootPath);

  await firstStore.record([room('100', 99)], 1000);

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
