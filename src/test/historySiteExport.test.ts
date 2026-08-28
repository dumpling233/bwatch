import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  exportHistorySiteData,
  HistorySiteDateIndexFile,
  HistorySiteIdleDateFile,
  HistorySiteManifest,
  HistorySiteRoomDateFile,
  HistorySiteSessionsFile
} from '../historySiteExport';
import { MementoLike, OnlineHistoryStore } from '../onlineHistoryStore';
import { LiveRoomStatus, MonitorSnapshot } from '../types';

class FakeMemento implements MementoLike {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function createFixture(t: TestContext): { root: string; store: OnlineHistoryStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwatch-history-site-'));
  fs.mkdirSync(path.join(root, 'site'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bwatch' }));
  fs.writeFileSync(path.join(root, 'site', 'index.html'), '<!doctype html>');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new OnlineHistoryStore(new FakeMemento(), path.join(root, 'storage')) };
}

function room(roomId: string, anchorName: string, online: number | null): LiveRoomStatus {
  return {
    roomId,
    title: `${anchorName} 直播间`,
    anchorName,
    fansCount: null,
    status: online === null ? 'unknown' : online > 0 ? 'live' : 'offline',
    online,
    popularity: null,
    guardFleet: null,
    liveStartTime: null,
    liveDurationText: '-',
    lastUpdatedAt: Date.now()
  };
}

function snapshot(rooms: LiveRoomStatus[]): MonitorSnapshot {
  return {
    rooms,
    settings: {
      rooms: rooms.map((item) => item.roomId),
      groups: [{ id: 'favorites', name: '常看', rooms: rooms.map((item) => item.roomId) }],
      autoRefreshEnabled: true,
      autoRefreshIntervalSeconds: 15,
      liveStartNotificationsEnabled: false
    },
    loading: false,
    lastRefreshAt: null,
    onlineHistory: {}
  };
}

function localDate(timestampMs: number): string {
  const value = new Date(timestampMs);
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

test('history site v2 export preserves timestamps, null samples, midnight dates, and removed rooms', async (t) => {
  const { root, store } = createFixture(t);
  const beforeMidnight = new Date(2026, 7, 22, 23, 59, 45, 321).getTime();
  const afterMidnight = new Date(2026, 7, 23, 0, 0, 0, 654).getTime();
  const deletedRoomPoint = new Date(2026, 7, 23, 0, 0, 15, 987).getTime();

  await store.record([room('100', '主播甲', 42)], beforeMidnight);
  await store.record([room('100', '主播甲', null)], afterMidnight);
  await store.record([room('200', '已移除主播', 9)], deletedRoomPoint);

  const current = snapshot([room('100', '主播甲', null), room('400', '尚无采样', 0)]);
  const generatedAt = new Date(2026, 7, 23, 12, 0, 0).getTime();
  const report = exportHistorySiteData(root, store, current, { generatedAt, timeZone: 'Asia/Shanghai' });
  const dataRoot = path.join(root, 'site', 'data', 'v2');
  const manifest = readJson<HistorySiteManifest>(path.join(dataRoot, 'manifest.json'));

  assert.equal(report.roomCount, 3);
  assert.equal(report.dateCount, 2);
  assert.equal(report.pointCount, 3);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.generatedAt, generatedAt);
  assert.equal(manifest.timeZone, 'Asia/Shanghai');
  assert.deepEqual(manifest.rooms.map((item) => item.roomId), ['100', '400', '200']);
  assert.equal(manifest.rooms[1].monitored, true);
  assert.equal(manifest.rooms[2].monitored, false);
  assert.equal(manifest.rooms[2].anchorName, '已移除主播');

  const firstMeta = manifest.dates.find((item) => item.date === localDate(beforeMidnight));
  const secondMeta = manifest.dates.find((item) => item.date === localDate(afterMidnight));
  assert.ok(firstMeta && secondMeta);
  const firstIndex = readJson<HistorySiteDateIndexFile>(path.join(dataRoot, firstMeta.indexFile.file));
  const secondIndex = readJson<HistorySiteDateIndexFile>(path.join(dataRoot, secondMeta.indexFile.file));
  assert.deepEqual(firstIndex.activeRooms.map((item) => item.roomId), ['100']);
  assert.deepEqual(secondIndex.activeRooms.map((item) => item.roomId), ['200']);
  assert.deepEqual(secondIndex.idleRoomIds, ['100']);

  const firstRoom = readJson<HistorySiteRoomDateFile>(path.join(dataRoot, firstIndex.activeRooms[0].dataFile.file));
  const secondRoom = readJson<HistorySiteRoomDateFile>(path.join(dataRoot, secondIndex.activeRooms[0].dataFile.file));
  const idle = readJson<HistorySiteIdleDateFile>(path.join(dataRoot, secondIndex.idleDataFile!.file));
  assert.deepEqual(firstRoom.points, [[beforeMidnight - firstMeta.startMs, 42]]);
  assert.deepEqual(idle.rooms[0].points, [[afterMidnight - secondMeta.startMs, null]]);
  assert.deepEqual(secondRoom.points, [[deletedRoomPoint - secondMeta.startMs, 9]]);
});

test('history site v2 sessions match the store and content revisions stay stable', async (t) => {
  const { root, store } = createFixture(t);
  const start = new Date(2026, 7, 23, 10, 0, 0, 111).getTime();
  await store.record([room('300', '场次主播', 10)], start);
  await store.record([room('300', '场次主播', null)], start + 15_000);
  await store.record([room('300', '场次主播', 18)], start + 30_000);
  await store.record([room('300', '场次主播', 0)], start + 45_000);

  const current = snapshot([room('300', '场次主播', 0)]);
  const options = { generatedAt: start + 60_000, timeZone: 'Asia/Shanghai' };
  const first = exportHistorySiteData(root, store, current, options);
  const dataRoot = path.join(root, 'site', 'data', 'v2');
  const manifestPath = path.join(dataRoot, 'manifest.json');
  const firstManifest = readJson<HistorySiteManifest>(manifestPath);
  const sessions = readJson<HistorySiteSessionsFile>(path.join(dataRoot, firstManifest.rooms[0].sessionFile.file));

  assert.deepEqual(sessions.sessions, store.getRoomSessions('300'));
  assert.ok(first.changedFileCount >= 4);

  const second = exportHistorySiteData(root, store, current, options);
  assert.equal(second.changedFileCount, 0);
  assert.equal(fs.existsSync(`${manifestPath}.tmp`), false);

  const third = exportHistorySiteData(root, store, current, { ...options, generatedAt: options.generatedAt + 1 });
  const thirdManifest = readJson<HistorySiteManifest>(manifestPath);
  assert.equal(third.changedFileCount, 1);
  assert.equal(thirdManifest.dates[0].indexFile.revision, firstManifest.dates[0].indexFile.revision);
  assert.equal(thirdManifest.rooms[0].sessionFile.revision, firstManifest.rooms[0].sessionFile.revision);
});
