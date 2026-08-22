export type LiveStatus = 'live' | 'offline' | 'unknown';

export interface LiveRoomStatus {
  roomId: string;
  shortRoomId?: string;
  title: string;
  anchorName: string;
  fansCount: number | null;
  fansCountStale?: boolean;
  fansCountLastSuccessAt?: number;
  cover?: string;
  status: LiveStatus;
  online: number | null;
  onlineStale?: boolean;
  onlineLastSuccessAt?: number;
  popularity: number | null;
  guardFleet: GuardFleet | null;
  guardFleetStale?: boolean;
  guardFleetLastSuccessAt?: number;
  liveStartTime: number | null;
  liveDurationText: string;
  lastUpdatedAt: number;
  error?: string;
}

export interface GuardFleet {
  total: number;
}

export interface LiveAnchorSearchResult {
  roomId: string;
  uid: string;
  uname: string;
  face?: string;
  category?: string;
  fansCount: number;
  isLive: boolean;
}

export interface RoomSearchResult {
  roomId: string;
  title: string;
  subtitle: string;
  detail: string;
  isLive: boolean;
  monitored: boolean;
  source: 'roomId' | 'anchor';
  face?: string;
}

export interface MonitorSettings {
  rooms: string[];
  groups: RoomGroup[];
  autoRefreshEnabled: boolean;
  autoRefreshIntervalSeconds: number;
  liveStartNotificationsEnabled: boolean;
  dataRefresh?: DataRefreshSettings;
}

export interface DataRefreshSettings {
  baseInfoIntervalSeconds: number;
  onlineIntervalSeconds: number;
  fansIntervalSeconds: number;
  guardIntervalSeconds: number;
}

export type NetworkProxyMode = 'auto' | 'manual' | 'off';

export interface NetworkProxySettings {
  mode: NetworkProxyMode;
  url: string;
}

export interface RoomGroup {
  id: string;
  name: string;
  rooms: string[];
}

export type OnlineViewerHistoryPoint = [timestampMs: number, online: number | null];

export type OnlineViewerHistory = Record<string, OnlineViewerHistoryPoint[]>;

export interface HistoryDateSummary {
  date: string;
  roomIds: string[];
  pointCount: number;
}

export interface HistoryRoomSeries {
  roomId: string;
  anchorName: string;
  points: OnlineViewerHistoryPoint[];
}

export interface HistoryQueryResult {
  date: string;
  dates?: string[];
  startMs: number;
  endMs: number;
  boundaryMs?: number;
  rooms: HistoryRoomSeries[];
}

export interface MonitorSnapshot {
  rooms: LiveRoomStatus[];
  settings: MonitorSettings;
  loading: boolean;
  lastRefreshAt: number | null;
  onlineHistory: OnlineViewerHistory;
  message?: string;
}
export interface LiveSessionSummary {
  roomId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  peakOnline: number;
  sampleCount: number;
  validSampleCount: number;
}
