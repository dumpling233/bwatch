import * as fs from 'fs';
import * as path from 'path';
import { OnlineHistoryStore } from './onlineHistoryStore';
import { LiveSessionSummary, LiveStatus, MonitorSnapshot, RoomGroup } from './types';

export const HISTORY_SITE_SCHEMA_VERSION = 1 as const;

const SITE_DATA_RELATIVE_PATH = path.join('site', 'data', 'v1');

export type HistorySitePoint = [offsetMs: number, online: number | null];

export interface HistorySiteRoomMetadata {
  roomId: string;
  anchorName: string;
  order: number;
  monitored: boolean;
  latestStatus: LiveStatus | null;
  latestOnline: number | null;
  sessionFile: string;
}

export interface HistorySiteDateMetadata {
  date: string;
  startMs: number;
  endMs: number;
  roomIds: string[];
  pointCount: number;
  file: string;
}

export interface HistorySiteManifest {
  schemaVersion: typeof HISTORY_SITE_SCHEMA_VERSION;
  generatedAt: number;
  timeZone: string;
  rooms: HistorySiteRoomMetadata[];
  groups: RoomGroup[];
  dates: HistorySiteDateMetadata[];
}

export interface HistorySiteDateFile {
  schemaVersion: typeof HISTORY_SITE_SCHEMA_VERSION;
  date: string;
  startMs: number;
  endMs: number;
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

  for (const summary of dateSummaries) {
    const query = historyStore.queryDateHistory(summary.date, 0, 23 * 60 + 59, currentNames);
    const rooms = query.rooms.map((room) => {
      anchorNames.set(room.roomId, room.anchorName);
      return {
        roomId: room.roomId,
        points: room.points.map(
          ([timestampMs, online]) => [timestampMs - query.startMs, online] as HistorySitePoint
        )
      };
    });
    const dateFile: HistorySiteDateFile = {
      schemaVersion: HISTORY_SITE_SCHEMA_VERSION,
      date: summary.date,
      startMs: query.startMs,
      endMs: query.endMs,
      rooms
    };
    const relativeFile = `dates/${summary.date}.json`;
    const writeResult = writeJsonIfChanged(path.join(outputRoot, relativeFile), dateFile);
    byteCount += writeResult.byteCount;
    changedFileCount += Number(writeResult.changed);
    pointCount += summary.pointCount;
    dates.push({
      date: summary.date,
      startMs: query.startMs,
      endMs: query.endMs,
      roomIds: summary.roomIds,
      pointCount: summary.pointCount,
      file: relativeFile
    });
  }

  const rooms: HistorySiteRoomMetadata[] = [];
  for (const [order, roomId] of orderedRoomIds.entries()) {
    const snapshotRoom = snapshotRooms.get(roomId);
    const sessionsFile: HistorySiteSessionsFile = {
      schemaVersion: HISTORY_SITE_SCHEMA_VERSION,
      roomId,
      sessions: historyStore.getRoomSessions(roomId)
    };
    const relativeFile = `sessions/${roomId}.json`;
    const writeResult = writeJsonIfChanged(path.join(outputRoot, relativeFile), sessionsFile);
    byteCount += writeResult.byteCount;
    changedFileCount += Number(writeResult.changed);
    rooms.push({
      roomId,
      anchorName: (anchorNames.get(roomId) ?? snapshotRoom?.anchorName?.trim()) || roomId,
      order,
      monitored: snapshot.settings.rooms.includes(roomId),
      latestStatus: snapshotRoom?.status ?? null,
      latestOnline: snapshotRoom?.online ?? null,
      sessionFile: relativeFile
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

function writeJsonIfChanged(filePath: string, value: unknown): { changed: boolean; byteCount: number } {
  const content = `${JSON.stringify(value)}\n`;
  const byteCount = Buffer.byteLength(content, 'utf8');
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) {
      return { changed: false, byteCount };
    }
  } catch {
    // Missing files are created below.
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
  return { changed: true, byteCount };
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
