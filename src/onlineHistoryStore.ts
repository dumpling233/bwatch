import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HistoryDateSummary,
  HistoryQueryResult,
  LiveSessionSummary,
  LiveRoomStatus,
  OnlineViewerHistory,
  OnlineViewerHistoryPoint
} from './types';

export const ONLINE_HISTORY_STORAGE_KEY = 'bwatch.onlineHistory.v1';
export const ONLINE_HISTORY_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ONLINE_HISTORY_RETENTION_MS = ONLINE_HISTORY_RECENT_WINDOW_MS;

const ONLINE_HISTORY_DIR_NAME = 'online-history';
const ONLINE_HISTORY_FILE_VERSION = 2;

interface StoredRoomHistoryFile {
  version: number;
  anchorName?: string;
  points: OnlineViewerHistoryPoint[];
}

interface SanitizedStoredRoomHistory {
  anchorName?: string;
  points: OnlineViewerHistoryPoint[];
}

export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export class OnlineHistoryStore {
  private readonly history: OnlineViewerHistory = {};
  private readonly anchorNames: Record<string, string> = {};
  private readonly historyDirPath: string | null;

  constructor(private readonly storage: MementoLike, storageRootPath?: string) {
    this.historyDirPath = storageRootPath ? path.join(storageRootPath, ONLINE_HISTORY_DIR_NAME) : null;
    this.loadLocalHistory();
    this.migrateLegacyGlobalState();
  }

  getHistory(nowMs = Date.now()): OnlineViewerHistory {
    return this.getRecentHistory(Object.keys(this.history), nowMs);
  }

  getHistoryForRooms(roomIds: readonly string[], nowMs = Date.now()): OnlineViewerHistory {
    return this.getRecentHistory(normalizeRoomIds(roomIds), nowMs);
  }

  getRoomHistory(
    roomId: string,
    startMs = Number.NEGATIVE_INFINITY,
    endMs = Number.POSITIVE_INFINITY
  ): OnlineViewerHistoryPoint[] {
    if (!isRoomId(roomId)) {
      return [];
    }

    return clonePoints(
      (this.history[roomId] ?? []).filter(([timestampMs]) => timestampMs >= startMs && timestampMs <= endMs)
    );
  }

  getRoomSessions(roomId: string): LiveSessionSummary[] {
    if (!isRoomId(roomId)) {
      return [];
    }

    const sessions: LiveSessionSummary[] = [];
    let current: {
      startMs: number;
      endMs: number;
      peakOnline: number;
      sampleCount: number;
      validSampleCount: number;
    } | undefined;

    for (const [timestampMs, online] of this.history[roomId] ?? []) {
      if (typeof online === 'number' && online > 0) {
        if (!current) {
          current = {
            startMs: timestampMs,
            endMs: timestampMs,
            peakOnline: online,
            sampleCount: 1,
            validSampleCount: 1
          };
        } else {
          current.endMs = timestampMs;
          current.peakOnline = Math.max(current.peakOnline, online);
          current.sampleCount += 1;
          current.validSampleCount += 1;
        }
        continue;
      }

      if (online === null && current) {
        current.sampleCount += 1;
        continue;
      }

      if (online === 0 && current) {
        sessions.push(createLiveSessionSummary(roomId, current));
        current = undefined;
      }
    }

    if (current) {
      sessions.push(createLiveSessionSummary(roomId, current));
    }

    return sessions.sort((left, right) => right.endMs - left.endMs);
  }

  getAvailableDates(): HistoryDateSummary[] {
    const dates = new Map<string, { roomIds: Set<string>; pointCount: number }>();

    for (const [roomId, points] of Object.entries(this.history)) {
      for (const [timestampMs] of points) {
        const date = formatLocalDate(timestampMs);
        const summary = dates.get(date) ?? { roomIds: new Set<string>(), pointCount: 0 };
        summary.roomIds.add(roomId);
        summary.pointCount += 1;
        dates.set(date, summary);
      }
    }

    return Array.from(dates.entries())
      .map(([date, summary]) => ({
        date,
        roomIds: Array.from(summary.roomIds).sort(compareRoomIds),
        pointCount: summary.pointCount
      }))
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  queryDateHistory(
    date: string,
    startMinute = 0,
    endMinute = 23 * 60 + 59,
    roomNames: Readonly<Record<string, string>> = {}
  ): HistoryQueryResult {
    return this.queryDateRangeHistory([date], startMinute, endMinute, roomNames);
  }

  queryDateRangeHistory(
    dates: readonly string[],
    startMinute = 0,
    endMinute = 23 * 60 + 59,
    roomNames: Readonly<Record<string, string>> = {}
  ): HistoryQueryResult {
    const normalizedDates = normalizeDateRange(dates);
    if (normalizedDates.length === 0) {
      return {
        date: dates[0] || '',
        dates: [],
        startMs: 0,
        endMs: 0,
        rooms: []
      };
    }

    const maxMinute = normalizedDates.length === 2 ? 2 * 24 * 60 - 1 : 23 * 60 + 59;
    const normalizedStartMinute = clampRangeMinute(startMinute, maxMinute);
    const normalizedEndMinute = clampRangeMinute(endMinute, maxMinute);
    const startOfDayMs = getLocalDateStartMs(normalizedDates[0]);
    const startMs = startOfDayMs + Math.min(normalizedStartMinute, normalizedEndMinute) * 60 * 1000;
    const endMs = startOfDayMs + Math.max(normalizedStartMinute, normalizedEndMinute) * 60 * 1000 + 60 * 1000 - 1;
    const rooms = Object.entries(this.history)
      .map(([roomId, points]) => ({
        roomId,
        anchorName: this.resolveAnchorName(roomId, roomNames[roomId]),
        points: clonePoints(points.filter(([timestampMs]) => timestampMs >= startMs && timestampMs <= endMs))
      }))
      .filter((room) => room.points.length > 0)
      .sort((left, right) => compareRoomIds(left.roomId, right.roomId));

    return {
      date: normalizedDates[0],
      dates: normalizedDates,
      startMs,
      endMs,
      boundaryMs: normalizedDates.length === 2 ? getLocalDateStartMs(normalizedDates[1]) : undefined,
      rooms
    };
  }

  async record(rooms: readonly LiveRoomStatus[], timestampMs = Date.now()): Promise<OnlineViewerHistory> {
    const activeRoomIds: string[] = [];
    const changedRoomIds = new Set<string>();

    for (const room of rooms) {
      if (!isRoomId(room.roomId)) {
        continue;
      }

      activeRoomIds.push(room.roomId);
      this.history[room.roomId] = mergePoints(this.history[room.roomId] ?? [], [[timestampMs, room.online]]);
      const anchorName = sanitizeAnchorName(room.roomId, room.anchorName);
      if (anchorName && this.anchorNames[room.roomId] !== anchorName) {
        this.anchorNames[room.roomId] = anchorName;
      }
      changedRoomIds.add(room.roomId);
    }

    await this.persistChangedRooms(changedRoomIds);
    return this.getHistoryForRooms(activeRoomIds, timestampMs);
  }

  async pruneRooms(roomIds: readonly string[], nowMs = Date.now()): Promise<OnlineViewerHistory> {
    return this.getHistoryForRooms(roomIds, nowMs);
  }

  async deleteRoom(roomId: string, nowMs = Date.now()): Promise<OnlineViewerHistory> {
    return this.getHistoryForRooms([roomId], nowMs);
  }

  private getRecentHistory(roomIds: readonly string[], nowMs: number): OnlineViewerHistory {
    const cutoff = nowMs - ONLINE_HISTORY_RECENT_WINDOW_MS;
    const recent: OnlineViewerHistory = {};

    for (const roomId of normalizeRoomIds(roomIds)) {
      const points = this.history[roomId] ?? [];
      const visiblePoints = points.filter(([timestampMs]) => timestampMs >= cutoff && timestampMs <= nowMs);
      if (visiblePoints.length > 0) {
        recent[roomId] = clonePoints(visiblePoints);
      }
    }

    return recent;
  }

  private resolveAnchorName(roomId: string, currentName?: string): string {
    return sanitizeAnchorName(roomId, currentName) ?? this.anchorNames[roomId] ?? roomId;
  }

  private loadLocalHistory(): void {
    if (!this.historyDirPath) {
      return;
    }

    try {
      fs.mkdirSync(this.historyDirPath, { recursive: true });
      for (const fileName of fs.readdirSync(this.historyDirPath)) {
        if (!fileName.endsWith('.json')) {
          continue;
        }

        const roomId = path.basename(fileName, '.json');
        if (!isRoomId(roomId)) {
          continue;
        }

        try {
          const filePath = path.join(this.historyDirPath, fileName);
          const stored = sanitizeStoredRoomHistory(roomId, JSON.parse(fs.readFileSync(filePath, 'utf8')));
          if (stored.points.length > 0) {
            this.history[roomId] = mergePoints(this.history[roomId] ?? [], stored.points);
          }
          if (stored.anchorName) {
            this.anchorNames[roomId] = stored.anchorName;
          }
        } catch {
          // Ignore one broken room file without preventing other rooms from loading.
        }
      }
    } catch {
      // Disk history is best-effort; monitoring should still work if local files are unreadable.
    }
  }

  private migrateLegacyGlobalState(): void {
    const legacyHistory = sanitizeHistory(this.storage.get<unknown>(ONLINE_HISTORY_STORAGE_KEY, {}));
    const changedRoomIds = new Set<string>();

    for (const [roomId, points] of Object.entries(legacyHistory)) {
      this.history[roomId] = mergePoints(this.history[roomId] ?? [], points);
      changedRoomIds.add(roomId);
    }

    void this.persistChangedRooms(changedRoomIds);
  }

  private async persistChangedRooms(roomIds: ReadonlySet<string>): Promise<void> {
    if (roomIds.size === 0) {
      return;
    }

    if (!this.historyDirPath) {
      try {
        await this.storage.update(ONLINE_HISTORY_STORAGE_KEY, cloneHistory(this.history));
      } catch {
        // Keep in-memory samples even if VSCode state persistence fails.
      }
      return;
    }

    try {
      fs.mkdirSync(this.historyDirPath, { recursive: true });
      for (const roomId of roomIds) {
        this.persistRoom(roomId);
      }
    } catch {
      // Keep in-memory samples even if local persistence fails.
    }
  }

  private persistRoom(roomId: string): void {
    if (!this.historyDirPath || !isRoomId(roomId)) {
      return;
    }

    const filePath = path.join(this.historyDirPath, `${roomId}.json`);
    const tempFilePath = `${filePath}.tmp`;
    fs.writeFileSync(
      tempFilePath,
      JSON.stringify(serializeStoredRoomHistory(roomId, this.history[roomId] ?? [], this.anchorNames[roomId])),
      'utf8'
    );
    fs.renameSync(tempFilePath, filePath);
  }
}

function createLiveSessionSummary(
  roomId: string,
  session: {
    startMs: number;
    endMs: number;
    peakOnline: number;
    sampleCount: number;
    validSampleCount: number;
  }
): LiveSessionSummary {
  return {
    roomId,
    startMs: session.startMs,
    endMs: session.endMs,
    durationMs: Math.max(0, session.endMs - session.startMs),
    peakOnline: session.peakOnline,
    sampleCount: session.sampleCount,
    validSampleCount: session.validSampleCount
  };
}

function sanitizeStoredRoomHistory(roomId: string, value: unknown): SanitizedStoredRoomHistory {
  if (Array.isArray(value)) {
    return {
      points: sanitizePoints(value)
    };
  }

  if (!value || typeof value !== 'object') {
    return {
      points: []
    };
  }

  const stored = value as { anchorName?: unknown; points?: unknown };
  return {
    anchorName: sanitizeAnchorName(roomId, stored.anchorName),
    points: sanitizePoints(stored.points)
  };
}

function serializeStoredRoomHistory(
  roomId: string,
  points: readonly OnlineViewerHistoryPoint[],
  anchorName?: string
): StoredRoomHistoryFile {
  const stored: StoredRoomHistoryFile = {
    version: ONLINE_HISTORY_FILE_VERSION,
    points: clonePoints(points)
  };
  const validAnchorName = sanitizeAnchorName(roomId, anchorName);
  if (validAnchorName) {
    stored.anchorName = validAnchorName;
  }
  return stored;
}

function sanitizeHistory(value: unknown): OnlineViewerHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const history: OnlineViewerHistory = {};
  for (const [roomId, rawPoints] of Object.entries(value)) {
    if (!isRoomId(roomId)) {
      continue;
    }

    const stored = sanitizeStoredRoomHistory(roomId, rawPoints);
    if (stored.points.length > 0) {
      history[roomId] = stored.points;
    }
  }

  return history;
}

function sanitizePoints(value: unknown): OnlineViewerHistoryPoint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const points: OnlineViewerHistoryPoint[] = [];
  for (const rawPoint of value) {
    if (!Array.isArray(rawPoint) || rawPoint.length !== 2) {
      continue;
    }

    const [timestampMs, online] = rawPoint;
    if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) {
      continue;
    }

    if (online === null || (typeof online === 'number' && Number.isFinite(online) && online >= 0)) {
      points.push([timestampMs, online]);
    }
  }

  return points.sort((left, right) => left[0] - right[0]);
}

function mergePoints(
  existing: readonly OnlineViewerHistoryPoint[],
  incoming: readonly OnlineViewerHistoryPoint[]
): OnlineViewerHistoryPoint[] {
  const pointsByTimestamp = new Map<number, OnlineViewerHistoryPoint>();

  for (const [timestampMs, online] of sanitizePoints([...existing, ...incoming])) {
    pointsByTimestamp.set(timestampMs, [timestampMs, online]);
  }

  return Array.from(pointsByTimestamp.values()).sort((left, right) => left[0] - right[0]);
}

function normalizeRoomIds(roomIds: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const roomId of roomIds) {
    if (!isRoomId(roomId) || seen.has(roomId)) {
      continue;
    }

    seen.add(roomId);
    normalized.push(roomId);
  }

  return normalized;
}

function isRoomId(roomId: string): boolean {
  return /^\d+$/.test(roomId);
}

function sanitizeAnchorName(roomId: string, value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === '-' || trimmed === roomId || trimmed === `房间 ${roomId}`) {
    return undefined;
  }

  return trimmed;
}

function isLocalDateString(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function formatLocalDate(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getLocalDateStartMs(date: string): number {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

function clampDayMinute(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(23 * 60 + 59, Math.max(0, Math.floor(value)));
}

function clampRangeMinute(value: number, maxMinute: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(maxMinute, Math.max(0, Math.floor(value)));
}

function normalizeDateRange(dates: readonly string[]): string[] {
  const uniqueDates = Array.from(new Set(dates.filter(isLocalDateString))).sort();
  if (uniqueDates.length === 1) {
    return uniqueDates;
  }
  if (uniqueDates.length !== 2) {
    return [];
  }

  const firstDay = getLocalDateStartMs(uniqueDates[0]);
  const secondDay = getLocalDateStartMs(uniqueDates[1]);
  return secondDay - firstDay === 24 * 60 * 60 * 1000 ? uniqueDates : [];
}

function compareRoomIds(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return left.localeCompare(right);
}

function cloneHistory(history: OnlineViewerHistory): OnlineViewerHistory {
  const cloned: OnlineViewerHistory = {};
  for (const [roomId, points] of Object.entries(history)) {
    cloned[roomId] = clonePoints(points);
  }
  return cloned;
}

function clonePoints(points: readonly OnlineViewerHistoryPoint[]): OnlineViewerHistoryPoint[] {
  return points.map(([timestampMs, online]) => [timestampMs, online]);
}
