import { BilibiliLiveClient } from './bilibiliClient';
import { MonitorSettings, MonitorSnapshot, OnlineViewerHistory } from './types';

export interface LiveMonitorNotifier {
  notifyLiveStart(roomId: string, anchorName: string, title: string): void;
}

interface OnlineHistoryRecorder {
  getHistory(nowMs?: number): OnlineViewerHistory;
  getHistoryForRooms?(roomIds: readonly string[], nowMs?: number): OnlineViewerHistory;
  record(rooms: MonitorSnapshot['rooms'], timestampMs?: number): Promise<OnlineViewerHistory>;
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
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<(snapshot: MonitorSnapshot) => void>();
  private previousLiveStates = new Map<string, boolean>();

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
      onlineHistory: this.getHistoryForRooms(settings.rooms)
    };
    this.restartPolling();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.listeners.clear();
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
    this.settings = settings;
    const onlineHistory = this.getHistoryForRooms(settings.rooms);
    this.snapshot = {
      ...this.snapshot,
      settings,
      rooms: this.snapshot.rooms.filter((room) => settings.rooms.includes(room.roomId)),
      onlineHistory
    };
    this.emit();
    this.restartPolling();
    void this.historyRecorder.pruneRooms(settings.rooms).then((prunedHistory) => {
      this.snapshot = {
        ...this.snapshot,
        onlineHistory: prunedHistory
      };
      this.emit();
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshInternal().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refreshInternal(): Promise<void> {
    if (this.settings.rooms.length === 0) {
      const nowMs = Date.now();
      const onlineHistory = await this.historyRecorder.pruneRooms([], nowMs);
      this.snapshot = {
        rooms: [],
        settings: this.settings,
        loading: false,
        lastRefreshAt: nowMs,
        onlineHistory,
        message: '请添加 B站直播间房间号'
      };
      this.emit();
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      loading: true,
      message: undefined
    };
    this.emit();

    const rooms = await this.client.fetchRooms(this.settings.rooms);
    this.handleLiveStartNotifications(rooms);
    const nowMs = Date.now();
    const onlineHistory = await this.historyRecorder.record(rooms, nowMs);

    this.snapshot = {
      rooms,
      settings: this.settings,
      loading: false,
      lastRefreshAt: nowMs,
      onlineHistory
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
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (!this.settings.autoRefreshEnabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.refresh();
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
