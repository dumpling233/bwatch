import { LiveAnchorSearchResult, LiveRoomStatus, RoomSearchResult } from './types';

interface SearchResultDetails {
  roomId: string;
  anchorName: string;
  category?: string;
  fansCount: number | null;
  isLive: boolean;
  monitored: boolean;
  source: RoomSearchResult['source'];
  face?: string;
}

export function roomStatusToSearchResult(
  room: LiveRoomStatus,
  monitored: boolean
): RoomSearchResult | undefined {
  if (room.status === 'unknown' || room.error) {
    return undefined;
  }

  return createSearchResult({
    roomId: room.roomId,
    anchorName: room.anchorName,
    fansCount: room.fansCount,
    isLive: room.status === 'live',
    monitored,
    source: 'roomId'
  });
}

export function anchorToSearchResult(
  anchor: LiveAnchorSearchResult,
  monitored: boolean
): RoomSearchResult {
  return createSearchResult({
    roomId: anchor.roomId,
    anchorName: anchor.uname,
    category: anchor.category,
    fansCount: anchor.fansCount,
    isLive: anchor.isLive,
    monitored,
    source: 'anchor',
    face: anchor.face
  });
}

function createSearchResult(details: SearchResultDetails): RoomSearchResult {
  return {
    roomId: details.roomId,
    title: details.anchorName || `房间 ${details.roomId}`,
    subtitle: `房间 ${details.roomId}`,
    detail: `${details.category || '未知分区'} · 粉丝 ${formatCount(details.fansCount)} · ${
      details.isLive ? '直播中' : '未开播'
    }`,
    isLive: details.isLive,
    monitored: details.monitored,
    source: details.source,
    face: details.face
  };
}

function formatCount(value: number | null): string {
  return value === null ? '--' : new Intl.NumberFormat('zh-CN').format(value);
}
