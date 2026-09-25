import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
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
const ONLINE_HISTORY_WAL_VERSION = 1;
const ONLINE_HISTORY_MIGRATION_KEY = 'bwatch.onlineHistory.migrated.v2';
const ONLINE_HISTORY_FLUSH_INTERVAL_MS = 1_000;
const ONLINE_HISTORY_MAX_PENDING_AGE_MS = 5_000;
const ONLINE_HISTORY_COMPACTION_RECORDS = 2_000;
const ONLINE_HISTORY_MAX_IN_MEMORY_POINTS = 12_000;
const ONLINE_HISTORY_QUERY_CONCURRENCY = 4;

interface StoredRoomHistoryFile {
  version: number;
  anchorName?: string;
  points: OnlineViewerHistoryPoint[];
}

interface SanitizedStoredRoomHistory {
  anchorName?: string;
  points: OnlineViewerHistoryPoint[];
}

interface WalRecord {
  version: number;
  sequence: number;
  timestampMs: number;
  online: number | null;
  anchorName?: string;
  checksum: string;
}

interface RoomPersistenceQueue {
  records: WalRecord[];
  pendingSince?: number;
  lastPersistedSequence: number;
  processing?: Promise<void>;
  failedWrites: number;
  lastError?: string;
}

export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export type PersistenceState = 'healthy' | 'degraded' | 'failed';

export interface PersistenceStatus {
  state: PersistenceState;
  enqueuedSequence: number;
  lastPersistedSequence: number;
  pendingAgeMs: number;
  pendingRooms: number;
  failedWrites: number;
  lastError?: string;
}

export class OnlineHistoryStore {
  private readonly history: OnlineViewerHistory = {};
  private readonly anchorNames: Record<string, string> = {};
  private readonly historyDirPath: string | null;
  private readonly roomSequences = new Map<string, number>();
  private readonly roomQueues = new Map<string, RoomPersistenceQueue>();
  private readonly migrationPending: Promise<void>;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private persistenceState: PersistenceState = 'healthy';
  private lastPersistenceError: string | undefined;

  readonly ready: Promise<void>;

  constructor(private readonly storage: MementoLike, storageRootPath?: string) {
    this.historyDirPath = storageRootPath ? path.join(storageRootPath, ONLINE_HISTORY_DIR_NAME) : null;
    this.loadLocalHistory();
    this.migrationPending = this.migrateLegacyGlobalState();
    this.ready = this.migrationPending.then(() => undefined);
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
      this.getCompleteRoomHistory(roomId).filter(([timestampMs]) => timestampMs >= startMs && timestampMs <= endMs)
    );
  }

  getRoomSessions(roomId: string): LiveSessionSummary[] {
    if (!isRoomId(roomId)) {
      return [];
    }
    return summarizeLiveSessions(roomId, this.getCompleteRoomHistory(roomId));
  }

  getAvailableDates(): HistoryDateSummary[] {
    const dates = new Map<string, { roomIds: Set<string>; pointCount: number }>();

    for (const roomId of this.getKnownRoomIds()) {
      const points = this.getCompleteRoomHistory(roomId);
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
    const rooms = this.getKnownRoomIds()
      .map((roomId) => ({
        roomId,
        anchorName: this.resolveAnchorName(roomId, roomNames[roomId]),
        points: clonePoints(this.getCompleteRoomHistory(roomId).filter(([timestampMs]) => timestampMs >= startMs && timestampMs <= endMs))
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

  /**
   * Reads long-term history without synchronously blocking the extension host on disk IO.
   * The synchronous API remains available for exports and legacy callers.
   */
  async getAvailableDatesAsync(): Promise<HistoryDateSummary[]> {
    await this.ready;
    if (!this.historyDirPath) {
      return this.getAvailableDates();
    }

    const dates = new Map<string, { roomIds: Set<string>; pointCount: number }>();
    const roomIds = await this.getKnownRoomIdsAsync();
    const histories = await this.readRoomHistoriesAsync(roomIds);
    for (const [roomId, points] of histories) {
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

  async queryDateRangeHistoryAsync(
    dates: readonly string[],
    startMinute = 0,
    endMinute = 23 * 60 + 59,
    roomNames: Readonly<Record<string, string>> = {}
  ): Promise<HistoryQueryResult> {
    await this.ready;
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
    const roomIds = await this.getKnownRoomIdsAsync();
    const histories = await this.readRoomHistoriesAsync(roomIds);
    const rooms = histories
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

  async getRoomSessionsAsync(roomId: string): Promise<LiveSessionSummary[]> {
    await this.ready;
    if (!isRoomId(roomId)) {
      return [];
    }
    return summarizeLiveSessions(roomId, await this.getCompleteRoomHistoryAsync(roomId));
  }

  async record(rooms: readonly LiveRoomStatus[], timestampMs = Date.now()): Promise<OnlineViewerHistory> {
    await this.ready;
    const activeRoomIds: string[] = [];
    for (const room of rooms) {
      if (!isRoomId(room.roomId)) {
        continue;
      }

      activeRoomIds.push(room.roomId);
      const point: OnlineViewerHistoryPoint = [timestampMs, room.online];
      this.history[room.roomId] = mergePoints(this.history[room.roomId] ?? [], [point]);
      this.trimRoomHistoryInMemory(room.roomId, timestampMs);
      const anchorName = sanitizeAnchorName(room.roomId, room.anchorName);
      if (anchorName && this.anchorNames[room.roomId] !== anchorName) {
        this.anchorNames[room.roomId] = anchorName;
      }
      const queue = this.getRoomQueue(room.roomId);
      const sequence = (this.roomSequences.get(room.roomId) ?? 0) + 1;
      this.roomSequences.set(room.roomId, sequence);
      const record = createWalRecord(sequence, timestampMs, room.online, this.anchorNames[room.roomId]);
      queue.records.push(record);
      queue.pendingSince ??= Date.now();
    }

    this.scheduleFlush();
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
        const extension = path.extname(fileName);
        const roomId = path.basename(fileName, extension);
        if (!isRoomId(roomId) || (extension !== '.json' && extension !== '.wal')) {
          continue;
        }
        const filePath = path.join(this.historyDirPath, fileName);
        try {
          if (extension === '.json') {
            const stored = sanitizeStoredRoomHistory(roomId, JSON.parse(fs.readFileSync(filePath, 'utf8')));
            if (stored.points.length > 0) {
              this.history[roomId] = mergePoints(this.history[roomId] ?? [], stored.points);
            }
            if (stored.anchorName) {
              this.anchorNames[roomId] = stored.anchorName;
            }
            continue;
          }
          const walText = fs.readFileSync(filePath, 'utf8');
          const records = walText.split(String.fromCharCode(10));
          const parsed = records.map((line) => parseWalRecord(line)).filter((record): record is WalRecord => record !== undefined);
          const lastContentIndex = findLastNonEmptyLineIndex(records);
          if (lastContentIndex >= 0 && !parseWalRecord(records[lastContentIndex])) {
            const repairedText = records.slice(0, lastContentIndex).join(String.fromCharCode(10));
            fs.truncateSync(filePath, Buffer.byteLength(repairedText + (repairedText ? String.fromCharCode(10) : ''), 'utf8'));
          }
          parsed.sort((left, right) => left.sequence - right.sequence);
          const seen = new Set<number>();
          for (const record of parsed) {
            if (seen.has(record.sequence)) {
              continue;
            }
            seen.add(record.sequence);
            applyWalRecord(this.history, this.anchorNames, roomId, record);
            this.roomSequences.set(roomId, Math.max(this.roomSequences.get(roomId) ?? 0, record.sequence));
          }
          const queue = this.getRoomQueue(roomId);
          queue.lastPersistedSequence = this.roomSequences.get(roomId) ?? 0;
        } catch {
          // Ignore one broken room file without preventing other rooms from loading.
        }
      }
      for (const roomId of Object.keys(this.history)) {
        this.trimRoomHistoryInMemory(roomId, Date.now());
      }
    } catch {
      // Monitoring continues with memory-only history when the storage directory is unavailable.
      this.persistenceState = 'degraded';
    }
  }

  private migrateLegacyGlobalState(): Promise<void> {
    if (this.storage.get<boolean>(ONLINE_HISTORY_MIGRATION_KEY, false)) {
      return Promise.resolve();
    }

    const legacyHistory = sanitizeHistory(this.storage.get<unknown>(ONLINE_HISTORY_STORAGE_KEY, {}));
    let localMigrationSucceeded = true;
    for (const [roomId, points] of Object.entries(legacyHistory)) {
      this.history[roomId] = mergePoints(this.history[roomId] ?? [], points);
      this.roomSequences.set(roomId, points.length);
      if (this.historyDirPath) {
        try {
          this.persistRoomCheckpointSync(roomId);
        } catch (error) {
          localMigrationSucceeded = false;
          this.persistenceState = 'degraded';
          this.lastPersistenceError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    if (localMigrationSucceeded && this.historyDirPath) {
      for (const roomId of Object.keys(legacyHistory)) {
        this.trimRoomHistoryInMemory(roomId, Date.now());
      }
    }

    const migrationWrites: Promise<void>[] = [];
    if (!this.historyDirPath && Object.keys(legacyHistory).length > 0) {
      migrationWrites.push(Promise.resolve(this.storage.update(ONLINE_HISTORY_STORAGE_KEY, cloneHistory(this.history))));
    }
    if (localMigrationSucceeded) {
      migrationWrites.push(Promise.resolve(this.storage.update(ONLINE_HISTORY_MIGRATION_KEY, true)));
    }
    return Promise.all(migrationWrites).then(
      () => undefined,
      (error) => {
        this.persistenceState = 'degraded';
        this.lastPersistenceError = error instanceof Error ? error.message : String(error);
      }
    );
  }

  private getKnownRoomIds(): string[] {
    const roomIds = new Set(Object.keys(this.history));
    if (this.historyDirPath) {
      try {
        for (const fileName of fs.readdirSync(this.historyDirPath)) {
          const extension = path.extname(fileName);
          if (extension !== '.json' && extension !== '.wal') {
            continue;
          }
          const roomId = path.basename(fileName, extension);
          if (isRoomId(roomId)) {
            roomIds.add(roomId);
          }
        }
      } catch {
        // Fall back to the in-memory room set when the directory is unavailable.
      }
    }
    return normalizeRoomIds(Array.from(roomIds));
  }

  private async getKnownRoomIdsAsync(): Promise<string[]> {
    const roomIds = new Set(Object.keys(this.history));
    if (!this.historyDirPath) {
      return normalizeRoomIds(Array.from(roomIds));
    }

    try {
      for (const fileName of await fsPromises.readdir(this.historyDirPath)) {
        const extension = path.extname(fileName);
        if (extension !== '.json' && extension !== '.wal') {
          continue;
        }
        const roomId = path.basename(fileName, extension);
        if (isRoomId(roomId)) {
          roomIds.add(roomId);
        }
      }
    } catch {
      // Fall back to the in-memory room set when the directory is unavailable.
    }
    return normalizeRoomIds(Array.from(roomIds));
  }

  private getCompleteRoomHistory(roomId: string): OnlineViewerHistoryPoint[] {
    if (!this.historyDirPath || !isRoomId(roomId)) {
      return clonePoints(this.history[roomId] ?? []);
    }

    const points: OnlineViewerHistoryPoint[] = [];
    const jsonPath = path.join(this.historyDirPath, roomId + '.json');
    try {
      const stored = sanitizeStoredRoomHistory(roomId, JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
      points.push(...stored.points);
    } catch {
      // The WAL or the in-memory projection may still contain usable samples.
    }

    const walPath = path.join(this.historyDirPath, roomId + '.wal');
    try {
      const records = fs.readFileSync(walPath, 'utf8')
        .split(String.fromCharCode(10))
        .map((line) => parseWalRecord(line))
        .filter((record): record is WalRecord => record !== undefined)
        .sort((left, right) => left.sequence - right.sequence);
      const seenSequences = new Set<number>();
      for (const record of records) {
        if (seenSequences.has(record.sequence)) {
          continue;
        }
        seenSequences.add(record.sequence);
        points.push([record.timestampMs, record.online]);
      }
    } catch {
      // Keep the valid JSON baseline and recent in-memory points.
    }

    return mergePoints(points, this.history[roomId] ?? []);
  }

  private async getCompleteRoomHistoryAsync(roomId: string): Promise<OnlineViewerHistoryPoint[]> {
    if (!this.historyDirPath || !isRoomId(roomId)) {
      return clonePoints(this.history[roomId] ?? []);
    }

    const points: OnlineViewerHistoryPoint[] = [];
    const jsonPath = path.join(this.historyDirPath, roomId + '.json');
    const walPath = path.join(this.historyDirPath, roomId + '.wal');
    const [jsonText, walText] = await Promise.all([
      fsPromises.readFile(jsonPath, 'utf8').catch(() => undefined),
      fsPromises.readFile(walPath, 'utf8').catch(() => undefined)
    ]);

    if (jsonText !== undefined) {
      try {
        const stored = sanitizeStoredRoomHistory(roomId, JSON.parse(jsonText));
        points.push(...stored.points);
      } catch {
        // The WAL or the in-memory projection may still contain usable samples.
      }
    }

    if (walText !== undefined) {
      const records = walText
        .split(String.fromCharCode(10))
        .map((line) => parseWalRecord(line))
        .filter((record): record is WalRecord => record !== undefined)
        .sort((left, right) => left.sequence - right.sequence);
      const seenSequences = new Set<number>();
      for (const record of records) {
        if (seenSequences.has(record.sequence)) {
          continue;
        }
        seenSequences.add(record.sequence);
        points.push([record.timestampMs, record.online]);
      }
    }

    return mergePoints(points, this.history[roomId] ?? []);
  }

  private async readRoomHistoriesAsync(
    roomIds: readonly string[]
  ): Promise<ReadonlyArray<readonly [string, OnlineViewerHistoryPoint[]]>> {
    const histories: Array<readonly [string, OnlineViewerHistoryPoint[]]> = [];
    let nextIndex = 0;
    const workerCount = Math.min(ONLINE_HISTORY_QUERY_CONCURRENCY, roomIds.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= roomIds.length) {
          return;
        }
        histories[index] = [roomIds[index], await this.getCompleteRoomHistoryAsync(roomIds[index])];
      }
    }));
    return histories;
  }

  private trimRoomHistoryInMemory(roomId: string, referenceMs: number): void {
    if (!this.historyDirPath) {
      return;
    }
    const points = this.history[roomId];
    if (!points || points.length <= ONLINE_HISTORY_MAX_IN_MEMORY_POINTS) {
      return;
    }
    const cutoffMs = referenceMs - ONLINE_HISTORY_RECENT_WINDOW_MS;
    const recentPoints = points.filter(([timestampMs]) => timestampMs >= cutoffMs);
    this.history[roomId] = (recentPoints.length > ONLINE_HISTORY_MAX_IN_MEMORY_POINTS
      ? recentPoints.slice(-ONLINE_HISTORY_MAX_IN_MEMORY_POINTS)
      : recentPoints);
  }

  private getRoomQueue(roomId: string): RoomPersistenceQueue {
    const existing = this.roomQueues.get(roomId);
    if (existing) {
      return existing;
    }
    const queue: RoomPersistenceQueue = {
      records: [],
      lastPersistedSequence: this.roomSequences.get(roomId) ?? 0,
      failedWrites: 0
    };
    this.roomQueues.set(roomId, queue);
    return queue;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    const nowMs = Date.now();
    let delayMs = ONLINE_HISTORY_FLUSH_INTERVAL_MS;
    for (const queue of this.roomQueues.values()) {
      if (queue.records.length === 0 || !queue.pendingSince) {
        continue;
      }
      delayMs = Math.min(delayMs, Math.max(0, ONLINE_HISTORY_MAX_PENDING_AGE_MS - (nowMs - queue.pendingSince)));
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(() => {
        this.scheduleFlush();
      });
    }, delayMs);
  }

  private async flushRooms(roomIds: ReadonlySet<string>): Promise<void> {
    const results = await Promise.allSettled(Array.from(roomIds, (roomId) => this.flushRoom(roomId)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
  }

  private async flushRoom(roomId: string): Promise<void> {
    const queue = this.getRoomQueue(roomId);
    if (queue.processing) {
      return queue.processing;
    }

    const task = (async () => {
      while (queue.records.length > 0) {
        const batch = queue.records.splice(0);
        try {
          await this.appendWalBatch(roomId, batch);
          queue.lastPersistedSequence = Math.max(queue.lastPersistedSequence, ...batch.map((record) => record.sequence));
          queue.pendingSince = queue.records.length > 0 ? queue.pendingSince : undefined;
          if (queue.lastPersistedSequence > 0 && queue.lastPersistedSequence % ONLINE_HISTORY_COMPACTION_RECORDS === 0) {
            await this.compactRoom(roomId);
          }
        } catch (error) {
          queue.records.unshift(...batch);
          queue.pendingSince ??= Date.now();
          queue.failedWrites += 1;
          queue.lastError = error instanceof Error ? error.message : String(error);
          this.persistenceState = 'failed';
          this.lastPersistenceError = queue.lastError;
          throw error;
        }
      }
      if (this.persistenceState !== 'healthy' && this.getPersistenceStatus().pendingRooms === 0) {
        this.persistenceState = 'healthy';
        this.lastPersistenceError = undefined;
      }
    })();

    queue.processing = task;
    try {
      await task;
    } finally {
      queue.processing = undefined;
      if (this.persistenceState !== 'healthy' && this.getPersistenceStatus().pendingRooms === 0) {
        this.persistenceState = 'healthy';
        this.lastPersistenceError = undefined;
      }
    }
  }

  private async appendWalBatch(roomId: string, records: readonly WalRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    if (!this.historyDirPath) {
      await this.storage.update(ONLINE_HISTORY_STORAGE_KEY, cloneHistory(this.history));
      return;
    }

    await fsPromises.mkdir(this.historyDirPath, { recursive: true });
    const walPath = path.join(this.historyDirPath, roomId + '.wal');
    const handle = await fsPromises.open(walPath, 'a');
    try {
      await handle.writeFile(records.map((record) => JSON.stringify(record)).join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async compactRoom(roomId: string): Promise<void> {
    if (!this.historyDirPath || !isRoomId(roomId)) {
      return;
    }
    const filePath = path.join(this.historyDirPath, roomId + '.json');
    const tempFilePath = filePath + '.tmp';
    const handle = await fsPromises.open(tempFilePath, 'w');
    try {
      await handle.writeFile(JSON.stringify(serializeStoredRoomHistory(roomId, this.getCompleteRoomHistory(roomId), this.anchorNames[roomId])), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsPromises.rename(tempFilePath, filePath);
    const walPath = path.join(this.historyDirPath, roomId + '.wal');
    const walHandle = await fsPromises.open(walPath, 'w');
    try {
      await walHandle.sync();
    } finally {
      await walHandle.close();
    }
  }

  private persistRoomCheckpointSync(roomId: string): void {
    if (!this.historyDirPath || !isRoomId(roomId)) {
      return;
    }
    fs.mkdirSync(this.historyDirPath, { recursive: true });
    const filePath = path.join(this.historyDirPath, roomId + '.json');
    const tempFilePath = filePath + '.tmp';
    fs.writeFileSync(tempFilePath, JSON.stringify(serializeStoredRoomHistory(roomId, this.history[roomId] ?? [], this.anchorNames[roomId])), 'utf8');
    try {
      const handle = fs.openSync(tempFilePath, 'r+');
      try {
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      // Some Windows file systems do not allow fsync on a newly created temp file.
    }
    fs.renameSync(tempFilePath, filePath);
  }

  async flush(): Promise<void> {
    await this.ready;
    while (true) {
      const roomIds = new Set(this.roomQueues.keys());
      await this.flushRooms(roomIds);
      if (this.getPersistenceStatus().pendingRooms === 0) {
        break;
      }
    }
    if (this.getPersistenceStatus().pendingRooms > 0) {
      throw new Error('history queue is not empty');
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  getPersistenceStatus(nowMs = Date.now()): PersistenceStatus {
    let enqueuedSequence = 0;
    let lastPersistedSequence = 0;
    let pendingAgeMs = 0;
    let pendingRooms = 0;
    let failedWrites = 0;
    for (const [roomId, queue] of this.roomQueues) {
      const sequence = this.roomSequences.get(roomId) ?? 0;
      enqueuedSequence += sequence;
      lastPersistedSequence += queue.lastPersistedSequence;
      failedWrites += queue.failedWrites;
      if (queue.records.length > 0 || queue.processing) {
        pendingRooms += 1;
        pendingAgeMs = Math.max(pendingAgeMs, queue.pendingSince ? Math.max(0, nowMs - queue.pendingSince) : 0);
      }
    }
    const state = this.persistenceState === 'healthy' && pendingAgeMs >= ONLINE_HISTORY_MAX_PENDING_AGE_MS
      ? 'degraded'
      : this.persistenceState;
    return {
      state,
      enqueuedSequence,
      lastPersistedSequence,
      pendingAgeMs,
      pendingRooms,
      failedWrites,
      ...(this.lastPersistenceError ? { lastError: this.lastPersistenceError } : {})
    };
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }
}



function createWalRecord(sequence: number, timestampMs: number, online: number | null, anchorName?: string): WalRecord {
  const payload = {
    version: ONLINE_HISTORY_WAL_VERSION,
    sequence,
    timestampMs,
    online,
    ...(anchorName ? { anchorName } : {})
  };
  return {
    ...payload,
    checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  };
}

function parseWalRecord(line: string): WalRecord | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const value = JSON.parse(line) as Partial<WalRecord>;
    const sequence = value.sequence;
    const timestampMs = value.timestampMs;
    const online = value.online;
    const checksum = value.checksum;
    if (
      value.version !== ONLINE_HISTORY_WAL_VERSION ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0 ||
      typeof timestampMs !== 'number' ||
      !Number.isFinite(timestampMs) ||
      (online !== null && (typeof online !== 'number' || !Number.isFinite(online) || online < 0)) ||
      typeof checksum !== 'string'
    ) {
      return undefined;
    }
    const payload = {
      version: ONLINE_HISTORY_WAL_VERSION,
      sequence,
      timestampMs,
      online,
      ...(typeof value.anchorName === 'string' ? { anchorName: value.anchorName } : {})
    };
    const expected = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (expected !== checksum) {
      return undefined;
    }
    return {
      ...payload,
      checksum
    };
  } catch {
    return undefined;
  }
}

function findLastNonEmptyLineIndex(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) {
      return index;
    }
  }
  return -1;
}

function applyWalRecord(
  history: OnlineViewerHistory,
  anchorNames: Record<string, string>,
  roomId: string,
  record: WalRecord
): void {
  history[roomId] = mergePoints(history[roomId] ?? [], [[record.timestampMs, record.online]]);
  const anchorName = sanitizeAnchorName(roomId, record.anchorName);
  if (anchorName) {
    anchorNames[roomId] = anchorName;
  }
}

function summarizeLiveSessions(roomId: string, points: readonly OnlineViewerHistoryPoint[]): LiveSessionSummary[] {
  const sessions: LiveSessionSummary[] = [];
  let current: {
    startMs: number;
    endMs: number;
    peakOnline: number;
    sampleCount: number;
    validSampleCount: number;
  } | undefined;

  for (const [timestampMs, online] of points) {
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
