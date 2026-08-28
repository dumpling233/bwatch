import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { OnlineHistoryStore } from './onlineHistoryStore';
import { LiveSessionSummary, LiveStatus, MonitorSnapshot, RoomGroup } from './types';

export const HISTORY_SITE_SCHEMA_VERSION = 2 as const;

const SITE_DATA_RELATIVE_PATH = path.join('site', 'data', 'v2');

export type HistorySitePoint = [offsetMs: number, online: number | null];

export interface HistorySiteFileReference {
  file: string;
  revision: string;
  byteCount: number;
  pointCount: number;
}

export interface HistorySiteRoomMetadata {
  roomId: string;
  anchorName: string;
  order: number;
  monitored: boolean;
  latestStatus: LiveStatus | null;
  latestOnline: number | null;
  sessionFile: HistorySiteFileReference;
}

export interface HistorySiteDateMetadata {
  date: string;
  startMs: number;
  endMs: number;
  roomIds: string[];
  activeRoomIds: string[];
  pointCount: number;
  indexFile: HistorySiteFileReference;
}

export interface HistorySiteManifest {
  schemaVersion: typeof HISTORY_SITE_SCHEMA_VERSION;
  generatedAt: number;
  timeZone: string;
  rooms: HistorySiteRoomMetadata[];
  groups: RoomGroup[];
  dates: HistorySiteDateMetadata[];
}

export interface HistorySiteActiveRoomReference {
  roomId: string;
  dataFile: HistorySiteFileReference;
}

export interface HistorySiteDateIndexFile {
  schemaVersion: typeof HISTORY_SITE_SCHEMA_VERSION;
  date: string;
  startMs: number;
  endMs: number;
  activeRooms: HistorySiteActiveRoomReference[];
  idleRoomIds: string[];
  idleDataFile: HistorySiteFileReference | null;
}

export interface HistorySiteRoomDateFile {
  schemaVersion: typeof HISTORY_SITE_SCHEMA_VERSION;
  date: string;
  roomId: string;
  points: HistorySitePoint[];
}

export interface HistorySiteIdleDateFile {
  schemaVersion: typeof HISTORY_SITE_SCHEMA_VERSION;
  date: string;
  rooms: Array<{ roomId: string; points: HistorySitePoint[] }>;
}

export interface HistorySiteSessionsFile {
  schemaVersion: typeof HISTORY_SITE_SCHEMA_VERSION;
  roomId: string;
  sessions: LiveSessionSummary[];
}

export interface HistorySiteExportOptions {
  generatedAt?: number;
  timeZone?: string;
}

export interface HistorySiteExportReport {
  rootPath: string;
  roomCount: number;
  dateCount: number;
  pointCount: number;
  byteCount: number;
  changedFileCount: number;
}

export function isBwatchRepositoryRoot(rootPath: string): boolean {
  if (!rootPath) {
    return false;
  }

  try {
    const packagePath = path.join(rootPath, 'package.json');
    const sitePath = path.join(rootPath, 'site', 'index.html');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { name?: unknown };
    return packageJson.name === 'bwatch' && fs.statSync(sitePath).isFile();
  } catch {
    return false;
  }
}

export function exportHistorySiteData(
  rootPath: string,
  historyStore: OnlineHistoryStore,
  snapshot: MonitorSnapshot,
  options: HistorySiteExportOptions = {}
): HistorySiteExportReport {
  if (!isBwatchRepositoryRoot(rootPath)) {
    throw new Error('请选择包含 package.json 和 site/index.html 的 bwatch 仓库根目录');
  }

  const generatedAt = normalizeTimestamp(options.generatedAt) ?? Date.now();
  const timeZone = normalizeTimeZone(options.timeZone);
  const outputRoot = path.join(rootPath, SITE_DATA_RELATIVE_PATH);
  fs.mkdirSync(path.join(outputRoot, 'dates'), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, 'sessions'), { recursive: true });

  const snapshotRooms = new Map(snapshot.rooms.map((room) => [room.roomId, room]));
  const currentNames = Object.fromEntries(
    snapshot.rooms
      .filter((room) => room.anchorName.trim())
      .map((room) => [room.roomId, room.anchorName.trim()])
  );
  const dateSummaries = historyStore.getAvailableDates();
  const historicalRoomIds = new Set(dateSummaries.flatMap((summary) => summary.roomIds));
  const exportRoomIds = new Set([...snapshot.settings.rooms, ...historicalRoomIds]);
  const orderedRoomIds = [
    ...snapshot.settings.rooms,
    ...Array.from(historicalRoomIds)
      .filter((roomId) => !snapshot.settings.rooms.includes(roomId))
      .sort(compareRoomIds)
  ];

  let byteCount = 0;
  let changedFileCount = 0;
  let pointCount = 0;
  const dates: HistorySiteDateMetadata[] = [];
  const anchorNames = new Map<string, string>();

  const writeDataFile = (relativeFile: string, value: unknown, filePointCount: number): HistorySiteFileReference => {
    const result = writeJsonIfChanged(path.join(outputRoot, relativeFile), value);
    byteCount += result.byteCount;
    changedFileCount += Number(result.changed);
    return {
      file: relativeFile.replace(/\\/g, '/'),
      revision: result.revision,
      byteCount: result.byteCount,
      pointCount: filePointCount
    };
  };

  for (const summary of dateSummaries) {
    const query = historyStore.queryDateHistory(summary.date, 0, 23 * 60 + 59, currentNames);
    const activeRooms: HistorySiteActiveRoomReference[] = [];
    const idleRooms: HistorySiteIdleDateFile['rooms'] = [];

    for (const room of query.rooms) {
      anchorNames.set(room.roomId, room.anchorName);
      const points = room.points.map(
        ([timestampMs, online]) => [timestampMs - query.startMs, online] as HistorySitePoint
      );
      if (points.some((point) => typeof point[1] === 'number' && point[1] > 0)) {
        const relativeFile = `dates/${summary.date}/active/${room.roomId}.json`;
        const dataFile: HistorySiteRoomDateFile = {
          schemaVersion: HISTORY_SITE_SCHEMA_VERSION,
          date: summary.date,
          roomId: room.roomId,
          points
        };
        activeRooms.push({
          roomId: room.roomId,
          dataFile: writeDataFile(relativeFile, dataFile, points.length)
        });
      } else {
        idleRooms.push({ roomId: room.roomId, points });
      }
    }

    const idlePointCount = idleRooms.reduce((total, room) => total + room.points.length, 0);
    const idleDataFile = idleRooms.length > 0
      ? writeDataFile(
        `dates/${summary.date}/idle.json`,
        { schemaVersion: HISTORY_SITE_SCHEMA_VERSION, date: summary.date, rooms: idleRooms } satisfies HistorySiteIdleDateFile,
        idlePointCount
      )
      : null;
    const indexFile: HistorySiteDateIndexFile = {
      schemaVersion: HISTORY_SITE_SCHEMA_VERSION,
      date: summary.date,
      startMs: query.startMs,
      endMs: query.endMs,
      activeRooms,
      idleRoomIds: idleRooms.map((room) => room.roomId),
      idleDataFile
    };
    const indexReference = writeDataFile(`dates/${summary.date}/index.json`, indexFile, summary.pointCount);
    pointCount += summary.pointCount;
    dates.push({
      date: summary.date,
      startMs: query.startMs,
      endMs: query.endMs,
      roomIds: summary.roomIds,
      activeRoomIds: activeRooms.map((room) => room.roomId),
      pointCount: summary.pointCount,
      indexFile: indexReference
    });
  }

  const rooms: HistorySiteRoomMetadata[] = [];
  for (const [order, roomId] of orderedRoomIds.entries()) {
    const snapshotRoom = snapshotRooms.get(roomId);
    const sessions = historyStore.getRoomSessions(roomId);
    const sessionsFile: HistorySiteSessionsFile = {
      schemaVersion: HISTORY_SITE_SCHEMA_VERSION,
      roomId,
      sessions
    };
    const sessionFile = writeDataFile(`sessions/${roomId}.json`, sessionsFile, sessions.length);
    rooms.push({
      roomId,
      anchorName: (anchorNames.get(roomId) ?? snapshotRoom?.anchorName?.trim()) || roomId,
      order,
      monitored: snapshot.settings.rooms.includes(roomId),
      latestStatus: snapshotRoom?.status ?? null,
      latestOnline: snapshotRoom?.online ?? null,
      sessionFile
    });
  }

  const groups = snapshot.settings.groups.map((group) => ({
    id: group.id,
    name: group.name,
    rooms: group.rooms.filter((roomId) => exportRoomIds.has(roomId))
  }));
  const manifest: HistorySiteManifest = {
    schemaVersion: HISTORY_SITE_SCHEMA_VERSION,
    generatedAt,
    timeZone,
    rooms,
    groups,
    dates
  };
  const manifestResult = writeJsonIfChanged(path.join(outputRoot, 'manifest.json'), manifest);
  byteCount += manifestResult.byteCount;
  changedFileCount += Number(manifestResult.changed);

  return {
    rootPath: outputRoot,
    roomCount: rooms.length,
    dateCount: dates.length,
    pointCount,
    byteCount,
    changedFileCount
  };
}

function writeJsonIfChanged(
  filePath: string,
  value: unknown
): { changed: boolean; byteCount: number; revision: string } {
  const content = `${JSON.stringify(value)}\n`;
  const byteCount = Buffer.byteLength(content, 'utf8');
  const revision = crypto.createHash('sha256').update(content).digest('hex');
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) {
      return { changed: false, byteCount, revision };
    }
  } catch {
    // Missing files are created below.
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
  return { changed: true, byteCount, revision };
}

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function normalizeTimeZone(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (candidate) {
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: candidate }).format(0);
      return candidate;
    } catch {
      // Fall through to the runtime time zone.
    }
  }

  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function compareRoomIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}
