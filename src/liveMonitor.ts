import { BilibiliLiveClient } from './bilibiliClient';
import { MonitorSettings, MonitorSnapshot, OnlineViewerHistory } from './types';

export interface LiveMonitorNotifier {
  notifyLiveStart(roomId: string, anchorName: string, title: string): void;
}

interface OnlineHistoryRecorder {
  readonly ready?: Promise<void>;
  getHistory(nowMs?: number): OnlineViewerHistory;
  getHistoryForRooms?(roomIds: readonly string[], nowMs?: number): OnlineViewerHistory;
  record(rooms: MonitorSnapshot['rooms'], timestampMs?: number): Promise<OnlineViewerHistory>;
  flush?(): Promise<void>;
  pruneRooms(roomIds: readonly string[], nowMs?: number): Promise<OnlineViewerHistory>;
}

const emptyHistoryRecorder: OnlineHistoryRecorder = {
  getHistory: () => ({}),
  record: async () => ({}),
  pruneRooms: async () => ({})
};

export class LiveMonitor {
  private snapshot: MonitorSnapshot;
  private refreshPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<(snapshot: MonitorSnapshot) => void>();
  private previousLiveStates = new Map<string, boolean>();
  private settingsRevision = 0;
  private snapshotRevision = 0;
  private refreshQueued = false;
  private disposed = false;

  constructor(
    private readonly client: BilibiliLiveClient,
    private settings: MonitorSettings,
    private readonly notifier: LiveMonitorNotifier,
    private readonly historyRecorder: OnlineHistoryRecorder = emptyHistoryRecorder
  ) {
    this.snapshot = {
      rooms: [],
      settings,
      loading: false,
      lastRefreshAt: null,
      onlineHistory: this.getHistoryForRooms(settings.rooms),
      revision: this.snapshotRevision
    };
    this.restartPolling();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.listeners.clear();
    const flush = this.historyRecorder.flush;
    if (flush) {
      void flush.call(this.historyRecorder).catch(() => undefined);
    }
  }

  onDidChange(listener: (snapshot: MonitorSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): MonitorSnapshot {
    return this.snapshot;
  }

  updateSettings(settings: MonitorSettings): void {
    if (this.disposed) {
      return;
    }
    this.settings = settings;
    this.settingsRevision += 1;
    const onlineHistory = this.getHistoryForRooms(settings.rooms);
    this.snapshot = {
      ...this.snapshot,
      settings,
      rooms: this.snapshot.rooms.filter((room) => settings.rooms.includes(room.roomId)),
      onlineHistory,
      revision: ++this.snapshotRevision
    };
    this.emit();
    this.restartPolling();
    void this.historyRecorder.pruneRooms(settings.rooms).then((prunedHistory) => {
      if (this.disposed) {
        return;
      }
      this.snapshot = {
        ...this.snapshot,
        onlineHistory: prunedHistory,
        revision: ++this.snapshotRevision
      };
      this.emit();
    }).catch(() => undefined);
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.refreshPromise) {
      this.refreshQueued = true;
      await this.refreshPromise.catch(() => undefined);
      return;
    }

    const revision = this.settingsRevision;
    const task = this.refreshInternal(revision);
    this.refreshPromise = task.finally(() => {
      this.refreshPromise = null;
      if (this.refreshQueued && !this.disposed) {
        this.refreshQueued = false;
        void this.refresh();
      } else {
        this.schedulePolling();
      }
    });
    return this.refreshPromise;
  }

  private async refreshInternal(expectedRevision: number): Promise<void> {
    if (this.disposed || expectedRevision !== this.settingsRevision) {
      return;
    }
    if (this.settings.rooms.length === 0) {
      const nowMs = Date.now();
      const onlineHistory = await this.historyRecorder.pruneRooms([], nowMs);
      if (this.disposed || expectedRevision !== this.settingsRevision) {
        return;
      }
      this.snapshot = {
        rooms: [],
        settings: this.settings,
        loading: false,
        lastRefreshAt: nowMs,
        onlineHistory,
        message: '\u8bf7\u6dfb\u52a0 B\u7ad9\u76f4\u64ad\u95f4\u623f\u95f4\u53f7',
        revision: ++this.snapshotRevision
      };
      this.emit();
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      loading: true,
      message: undefined,
      revision: ++this.snapshotRevision
    };
    this.emit();

    if (this.historyRecorder.ready) {
      await this.historyRecorder.ready;
    }
    const rooms = await this.client.fetchRooms(this.settings.rooms, Date.now(), this.settings.dataRefresh);
    if (this.disposed || expectedRevision !== this.settingsRevision) {
      return;
    }
    this.handleLiveStartNotifications(rooms);
    const nowMs = Date.now();
    let onlineHistory: OnlineViewerHistory;
    let persistenceError: string | undefined;
    try {
      onlineHistory = await this.historyRecorder.record(rooms, nowMs);
    } catch (error) {
      onlineHistory = this.getHistoryForRooms(this.settings.rooms, nowMs);
      const detail = error instanceof Error ? error.message : String(error);
      persistenceError = 'history persistence failed: ' + detail;
    }

    this.snapshot = {
      rooms,
      settings: this.settings,
      loading: false,
      lastRefreshAt: nowMs,
      onlineHistory,
      ...(persistenceError ? { message: persistenceError } : {}),
      revision: ++this.snapshotRevision
    };
    this.emit();
  }

  private handleLiveStartNotifications(rooms: MonitorSnapshot['rooms']): void {
    for (const room of rooms) {
      const wasLive = this.previousLiveStates.get(room.roomId) === true;
      const isLive = room.status === 'live';

      if (this.settings.liveStartNotificationsEnabled && !wasLive && isLive) {
        this.notifier.notifyLiveStart(room.roomId, room.anchorName, room.title);
      }

      if (room.status !== 'unknown') {
        this.previousLiveStates.set(room.roomId, isLive);
      }
    }
  }

  private restartPolling(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedulePolling();
  }

  private schedulePolling(): void {
    if (this.disposed || !this.settings.autoRefreshEnabled || this.refreshPromise) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch(() => undefined);
    }, this.settings.autoRefreshIntervalSeconds * 1000);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private getHistoryForRooms(roomIds: readonly string[], nowMs?: number): OnlineViewerHistory {
    if (this.historyRecorder.getHistoryForRooms) {
      return this.historyRecorder.getHistoryForRooms(roomIds, nowMs);
    }
    return filterHistoryByRooms(this.historyRecorder.getHistory(nowMs), roomIds);
  }
}

function filterHistoryByRooms(history: OnlineViewerHistory, roomIds: readonly string[]): OnlineViewerHistory {
  const roomIdSet = new Set(roomIds);
  const filtered: OnlineViewerHistory = {};
  for (const [roomId, points] of Object.entries(history)) {
    if (roomIdSet.has(roomId)) {
      filtered[roomId] = points;
    }
  }
  return filtered;
}
