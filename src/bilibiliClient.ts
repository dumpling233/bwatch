import { formatLiveDuration } from './time';
import { DataRefreshSettings, GuardFleet, LiveAnchorSearchResult, LiveRoomStatus } from './types';
import { DEFAULT_DATA_REFRESH_SETTINGS } from './config';
import { FetchLike, formatNetworkError } from './network';

const BASE_INFO_URL = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo';
const ONLINE_RANK_URL = 'https://api.live.bilibili.com/xlive/general-interface/v1/rank/getOnlineGoldRank';
const LIVE_USER_SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type';
const GUARD_FLEET_URL = 'https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList';
const RELATION_STAT_URL = 'https://api.bilibili.com/x/relation/stat';
const BILIBILI_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BILIBILI_SEARCH_BLOCKED_MESSAGE = 'B站主播搜索暂时被拦截，请稍后再试，或直接输入直播间房间号';
const ROOM_ENRICHMENT_CONCURRENCY = 6;
interface CachedNumber {
  value: number;
  fetchedAt: number;
}

interface CachedFieldResult<T> {
  value: T;
  stale: boolean;
  lastSuccessAt?: number;
}

interface BilibiliBaseInfoResponse {
  code?: number;
  message?: string;
  data?: {
    by_room_ids?: Record<string, BilibiliRoomInfo | undefined>;
  };
}

interface BilibiliRoomInfo {
  uid?: number;
  room_id?: number;
  roomid?: number;
  short_id?: number;
  title?: string;
  uname?: string;
  cover?: string;
  live_status?: number;
  online?: number;
  live_time?: number | string;
}

interface BilibiliOnlineRankResponse {
  code?: number;
  message?: string;
  data?: {
    onlineNum?: number;
    onlineNumText?: string;
  };
}

interface BilibiliGuardFleetResponse {
  code?: number;
  message?: string;
  data?: {
    info?: {
      num?: number;
    };
  };
}

interface BilibiliRelationStatResponse {
  code?: number;
  message?: string;
  data?: {
    follower?: number;
  };
}

interface BilibiliLiveUserSearchResponse {
  code?: number;
  message?: string;
  data?: {
    result?: BilibiliLiveUserSearchItem[];
  };
}

interface BilibiliLiveUserSearchItem {
  uid?: number;
  roomid?: number;
  uname?: string;
  uface?: string;
  cate_name?: string;
  attentions?: number;
  is_live?: boolean;
  live_status?: number;
}

export class BilibiliLiveClient {
  private readonly fansCache = new Map<string, CachedNumber>();
  private readonly guardCache = new Map<string, CachedNumber>();
  private readonly onlineCache = new Map<string, CachedNumber>();
  private baseInfoCache?: {
    roomIdsKey: string;
    payload: BilibiliBaseInfoResponse;
    fetchedAt: number;
  };

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async fetchRooms(
    roomIds: readonly string[],
    nowMs = Date.now(),
    refreshSettings: DataRefreshSettings = DEFAULT_DATA_REFRESH_SETTINGS
  ): Promise<LiveRoomStatus[]> {
    const uniqueRoomIds = [...new Set(roomIds)];
    if (uniqueRoomIds.length === 0) {
      return [];
    }

    try {
      const payload = await this.getBaseInfo(uniqueRoomIds, nowMs, refreshSettings.baseInfoIntervalSeconds);
      const statuses = uniqueRoomIds.map((roomId) => normalizeRoomInfo(roomId, payload.data?.by_room_ids?.[roomId], nowMs));

      return mapWithConcurrency(
        statuses,
        ROOM_ENRICHMENT_CONCURRENCY,
        async (status) => {
          const info = payload.data?.by_room_ids?.[status.roomId];
          if (!info?.uid) {
            return status;
          }

          const [online, guardFleet, fansCount] = await Promise.all([
            status.status === 'live'
              ? this.getOnlineViewerCount(status.roomId, info.uid, nowMs, refreshSettings.onlineIntervalSeconds)
              : Promise.resolve({ value: status.online, stale: false } as CachedFieldResult<number | null>),
            this.getGuardFleet(status.roomId, info.uid, nowMs, refreshSettings.guardIntervalSeconds),
            this.getFansCount(info.uid, nowMs, refreshSettings.fansIntervalSeconds)
          ]);

          return {
            ...status,
            online: status.status === 'live' ? online.value : status.online,
            onlineStale: online.stale,
            onlineLastSuccessAt: online.lastSuccessAt,
            guardFleet: guardFleet.value ?? status.guardFleet,
            guardFleetStale: guardFleet.stale,
            guardFleetLastSuccessAt: guardFleet.lastSuccessAt,
            fansCount: fansCount.value ?? status.fansCount,
            fansCountStale: fansCount.stale,
            fansCountLastSuccessAt: fansCount.lastSuccessAt
          };
        }
      );
    } catch (error) {
      const message = formatNetworkError(error);
      return uniqueRoomIds.map((roomId) => createErrorStatus(roomId, message, nowMs));
    }
  }

  private async getBaseInfo(
    roomIds: readonly string[],
    nowMs: number,
    intervalSeconds: number
  ): Promise<BilibiliBaseInfoResponse> {
    const roomIdsKey = [...roomIds].sort().join(',');
    if (
      this.baseInfoCache &&
      this.baseInfoCache.roomIdsKey === roomIdsKey &&
      nowMs - this.baseInfoCache.fetchedAt < intervalSeconds * 1000
    ) {
      return this.baseInfoCache.payload;
    }

    const payload = await this.requestBaseInfo(roomIds);
    this.baseInfoCache = { roomIdsKey, payload, fetchedAt: nowMs };
    return payload;
  }

  async searchLiveAnchors(keyword: string): Promise<LiveAnchorSearchResult[]> {
    const trimmedKeyword = keyword.trim();
    if (!trimmedKeyword) {
      return [];
    }

    const url = new URL(LIVE_USER_SEARCH_URL);
    url.searchParams.set('search_type', 'live_user');
    url.searchParams.set('keyword', trimmedKeyword);
    url.searchParams.set('page', '1');
    url.searchParams.set('page_size', '20');
    url.searchParams.set('order', 'online');
    url.searchParams.set('platform', 'pc');
    url.searchParams.set('highlight', '1');
    url.searchParams.set('single_column', '0');
    url.searchParams.set('from_source', 'webtop_search');

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: createBilibiliRequestHeaders({
          origin: 'https://search.bilibili.com',
          referer: `https://search.bilibili.com/live?keyword=${encodeURIComponent(trimmedKeyword)}`,
          includeVisitorCookie: true
        })
      });
    } catch (error) {
      throw new Error(formatNetworkError(error));
    }

    if (!response.ok) {
      if (response.status === 412) {
        throw new Error(BILIBILI_SEARCH_BLOCKED_MESSAGE);
      }
      throw new Error(`B站主播搜索接口返回 HTTP ${response.status}`);
    }

    const payload = (await response.json()) as BilibiliLiveUserSearchResponse;
    if (payload.code !== 0) {
      if (payload.code === -412) {
        throw new Error(BILIBILI_SEARCH_BLOCKED_MESSAGE);
      }
      throw new Error(payload.message || `B站主播搜索接口返回错误码 ${payload.code ?? 'unknown'}`);
    }

    return (payload.data?.result ?? [])
      .filter((item) => typeof item.roomid === 'number' && item.roomid > 0)
      .slice(0, 20)
      .map((item) => ({
        roomId: String(item.roomid),
        uid: String(item.uid ?? ''),
        uname: stripHtml(item.uname || '-'),
        face: normalizeImageUrl(item.uface),
        category: item.cate_name || undefined,
        fansCount: typeof item.attentions === 'number' ? item.attentions : 0,
        isLive: item.is_live === true || item.live_status === 1
      }));
  }

  private async requestBaseInfo(roomIds: readonly string[]): Promise<BilibiliBaseInfoResponse> {
    const url = new URL(BASE_INFO_URL);
    url.searchParams.set('req_biz', 'web_room_componet');
    for (const roomId of roomIds) {
      url.searchParams.append('room_ids', roomId);
    }

    const response = await this.fetchImpl(url, {
      headers: createBilibiliRequestHeaders({
        origin: 'https://live.bilibili.com',
        referer: 'https://live.bilibili.com/'
      })
    });

    if (!response.ok) {
      throw new Error(`B站接口返回 HTTP ${response.status}`);
    }

    const payload = (await response.json()) as BilibiliBaseInfoResponse;
    if (payload.code !== 0) {
      throw new Error(payload.message || `B站接口返回错误码 ${payload.code ?? 'unknown'}`);
    }

    return payload;
  }

  private async getOnlineViewerCount(
    roomId: string,
    uid: number,
    nowMs: number,
    intervalSeconds: number
  ): Promise<CachedFieldResult<number | null>> {
    const cacheKey = `${roomId}:${uid}`;
    const cached = this.onlineCache.get(cacheKey);
    if (cached && nowMs - cached.fetchedAt < intervalSeconds * 1000) {
      return { value: cached.value, stale: false, lastSuccessAt: cached.fetchedAt };
    }

    const online = await this.requestOnlineViewerCount(roomId, uid);
    if (online !== null) {
      this.onlineCache.set(cacheKey, { value: online, fetchedAt: nowMs });
      return { value: online, stale: false, lastSuccessAt: nowMs };
    }

    return cached
      ? { value: cached.value, stale: true, lastSuccessAt: cached.fetchedAt }
      : { value: null, stale: false };
  }

  private async requestOnlineViewerCount(roomId: string, uid: number): Promise<number | null> {
    try {
      const url = new URL(ONLINE_RANK_URL);
      url.searchParams.set('ruid', String(uid));
      url.searchParams.set('roomId', roomId);
      url.searchParams.set('page', '1');
      url.searchParams.set('pageSize', '1');

      const response = await this.fetchImpl(url, {
        headers: createBilibiliRequestHeaders({
          origin: 'https://live.bilibili.com',
          referer: `https://live.bilibili.com/${roomId}`
        })
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as BilibiliOnlineRankResponse;
      if (payload.code !== 0) {
        return null;
      }

      return typeof payload.data?.onlineNum === 'number' ? payload.data.onlineNum : null;
    } catch {
      return null;
    }
  }

  private async getGuardFleet(
    roomId: string,
    uid: number,
    nowMs = Date.now(),
    intervalSeconds = DEFAULT_DATA_REFRESH_SETTINGS.guardIntervalSeconds
  ): Promise<CachedFieldResult<GuardFleet | null>> {
    const cacheKey = `${roomId}:${uid}`;
    const cached = this.guardCache.get(cacheKey);
    if (cached && nowMs - cached.fetchedAt < intervalSeconds * 1000) {
      return { value: { total: cached.value }, stale: false, lastSuccessAt: cached.fetchedAt };
    }

    const fleet = await this.requestGuardFleet(roomId, uid);
    if (fleet) {
      this.guardCache.set(cacheKey, { value: fleet.total, fetchedAt: nowMs });
      return { value: fleet, stale: false, lastSuccessAt: nowMs };
    }

    return cached
      ? { value: { total: cached.value }, stale: true, lastSuccessAt: cached.fetchedAt }
      : { value: null, stale: false };
  }

  private async getFansCount(
    uid: number,
    nowMs = Date.now(),
    intervalSeconds = DEFAULT_DATA_REFRESH_SETTINGS.fansIntervalSeconds
  ): Promise<CachedFieldResult<number | null>> {
    const cacheKey = String(uid);
    const cached = this.fansCache.get(cacheKey);
    if (cached && nowMs - cached.fetchedAt < intervalSeconds * 1000) {
      return { value: cached.value, stale: false, lastSuccessAt: cached.fetchedAt };
    }

    const fansCount = await this.requestFansCount(uid);
    if (fansCount !== null) {
      this.fansCache.set(cacheKey, { value: fansCount, fetchedAt: nowMs });
      return { value: fansCount, stale: false, lastSuccessAt: nowMs };
    }

    return cached
      ? { value: cached.value, stale: true, lastSuccessAt: cached.fetchedAt }
      : { value: null, stale: false };
  }

  private async requestGuardFleet(roomId: string, uid: number): Promise<GuardFleet | null> {
    try {
      const url = new URL(GUARD_FLEET_URL);
      url.searchParams.set('roomid', roomId);
      url.searchParams.set('ruid', String(uid));
      url.searchParams.set('page', '1');
      url.searchParams.set('page_size', '1');

      const response = await this.fetchImpl(url, {
        headers: createBilibiliRequestHeaders({
          origin: 'https://live.bilibili.com',
          referer: `https://live.bilibili.com/${roomId}`
        })
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as BilibiliGuardFleetResponse;
      if (payload.code !== 0 || typeof payload.data?.info?.num !== 'number') {
        return null;
      }

      return {
        total: payload.data.info.num
      };
    } catch {
      return null;
    }
  }

  private async requestFansCount(uid: number): Promise<number | null> {
    try {
      const url = new URL(RELATION_STAT_URL);
      url.searchParams.set('vmid', String(uid));

      const response = await this.fetchImpl(url, {
        headers: createBilibiliRequestHeaders({
          origin: 'https://space.bilibili.com',
          referer: `https://space.bilibili.com/${uid}`
        })
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as BilibiliRelationStatResponse;
      if (payload.code !== 0 || typeof payload.data?.follower !== 'number') {
        return null;
      }

      return payload.data.follower;
    } catch {
      return null;
    }
  }
}

function createBilibiliRequestHeaders(options: {
  origin: string;
  referer: string;
  includeVisitorCookie?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    origin: options.origin,
    referer: options.referer,
    'user-agent': BILIBILI_BROWSER_USER_AGENT
  };

  if (options.includeVisitorCookie) {
    headers.cookie = createVisitorCookie();
  }

  return headers;
}

function createVisitorCookie(): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const buvid = createToken(32);
  const uuid = `${createToken(8)}-${createToken(4)}-${createToken(4)}-${createToken(4)}-${createToken(12)}infoc`;
  return [`buvid3=${buvid}`, `buvid4=${buvid}`, `buvid_fp=${buvid}`, `b_nut=${nowSeconds}`, `_uuid=${uuid}`].join('; ');
}

function createToken(length: number): string {
  const alphabet = '0123456789ABCDEF';
  let token = '';
  for (let index = 0; index < length; index += 1) {
    token += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return token;
}

export function normalizeRoomInfo(roomId: string, info: BilibiliRoomInfo | undefined, nowMs = Date.now()): LiveRoomStatus {
  if (!info) {
    return createErrorStatus(roomId, '直播间不存在或接口未返回该房间', nowMs);
  }

  const liveStartTime = parseLiveStartTime(info.live_time);
  const isLive = info.live_status === 1;
  const popularity = typeof info.online === 'number' ? info.online : null;

  return {
    roomId,
    shortRoomId: info.short_id ? String(info.short_id) : undefined,
    title: info.title || '-',
    anchorName: info.uname || '-',
    fansCount: null,
    cover: info.cover || undefined,
    status: isLive ? 'live' : 'offline',
    online: isLive ? null : 0,
    popularity,
    guardFleet: null,
    liveStartTime: isLive ? liveStartTime : null,
    liveDurationText: isLive ? formatLiveDuration(liveStartTime, nowMs) : '未开播',
    lastUpdatedAt: nowMs
  };
}

export function createErrorStatus(roomId: string, error: string, nowMs = Date.now()): LiveRoomStatus {
  return {
    roomId,
    title: '-',
    anchorName: '-',
    fansCount: null,
    status: 'unknown',
    online: null,
    popularity: null,
    guardFleet: null,
    liveStartTime: null,
    liveDurationText: '未知',
    lastUpdatedAt: nowMs,
    error
  };
}

function parseLiveStartTime(value: number | string | undefined): number | null {
  if (typeof value === 'number' && value > 0) {
    return value;
  }

  if (typeof value !== 'string' || value.trim() === '' || value === '0000-00-00 00:00:00') {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const normalized = value.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, '');
}

function normalizeImageUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.startsWith('//') ? `https:${value}` : value;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index], index);
      }
    })
  );

  return results;
}
