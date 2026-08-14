import { MonitorSettings, NetworkProxyMode, NetworkProxySettings, RoomGroup } from './types';

export const MIN_AUTO_REFRESH_INTERVAL_SECONDS = 15;

export interface RawConfiguration {
  get<T>(section: string, defaultValue: T): T;
}

export function normalizeRoomIds(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const roomId = String(value ?? '').trim();
    if (!/^\d+$/.test(roomId) || seen.has(roomId)) {
      continue;
    }

    seen.add(roomId);
    result.push(roomId);
  }

  return result;
}

export function clampAutoRefreshInterval(value: unknown): number {
  const interval = Number(value);
  if (!Number.isFinite(interval)) {
    return MIN_AUTO_REFRESH_INTERVAL_SECONDS;
  }

  return Math.max(MIN_AUTO_REFRESH_INTERVAL_SECONDS, Math.floor(interval));
}

export function normalizeRoomGroups(values: readonly unknown[], validRoomIds: readonly string[] = []): RoomGroup[] {
  const validRoomIdSet = new Set(validRoomIds);
  const seenGroupIds = new Set<string>();
  const seenGroupNames = new Set<string>();
  const result: RoomGroup[] = [];

  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const rawGroup = value as Partial<Record<'id' | 'name' | 'rooms', unknown>>;
    const name = String(rawGroup.name ?? '').trim();
    if (!name || seenGroupNames.has(name)) {
      continue;
    }

    const rawId = String(rawGroup.id ?? '').trim();
    const fallbackId = `group-${index}-${name}`;
    const id = sanitizeGroupId(rawId) || sanitizeGroupId(fallbackId);
    if (!id || seenGroupIds.has(id)) {
      continue;
    }

    const rooms = normalizeRoomIds(Array.isArray(rawGroup.rooms) ? rawGroup.rooms : []).filter(
      (roomId) => validRoomIdSet.size === 0 || validRoomIdSet.has(roomId)
    );

    seenGroupIds.add(id);
    seenGroupNames.add(name);
    result.push({ id, name, rooms });
  }

  return result;
}

export function reorderRoomGroups(
  groups: readonly RoomGroup[],
  groupId: string,
  offset: -1 | 1
): RoomGroup[] {
  const currentIndex = groups.findIndex((group) => group.id === groupId);
  return moveRoomGroupToIndex(groups, groupId, currentIndex + offset);
}

export function moveRoomGroupToIndex(
  groups: readonly RoomGroup[],
  groupId: string,
  targetIndex: number
): RoomGroup[] {
  const currentIndex = groups.findIndex((group) => group.id === groupId);
  if (currentIndex < 0 || groups.length === 0 || !Number.isFinite(targetIndex)) {
    return [...groups];
  }

  const boundedTargetIndex = Math.max(0, Math.min(groups.length - 1, Math.floor(targetIndex)));
  if (currentIndex === boundedTargetIndex) {
    return [...groups];
  }

  const reordered = [...groups];
  const [movedGroup] = reordered.splice(currentIndex, 1);
  reordered.splice(boundedTargetIndex, 0, movedGroup);
  return reordered;
}

export function renameRoomGroup(groups: readonly RoomGroup[], groupId: string, name: string): RoomGroup[] {
  const normalizedGroupId = String(groupId ?? '').trim();
  const normalizedName = String(name ?? '').trim();
  if (
    !normalizedGroupId ||
    !normalizedName ||
    normalizedName.length > 24 ||
    groups.some((group) => group.id !== normalizedGroupId && group.name === normalizedName)
  ) {
    return [...groups];
  }

  return groups.map((group) =>
    group.id === normalizedGroupId && group.name !== normalizedName
      ? { ...group, name: normalizedName }
      : group
  );
}

export function normalizeNetworkProxyMode(value: unknown): NetworkProxyMode {
  return value === 'manual' || value === 'off' ? value : 'auto';
}

export function readNetworkProxySettings(configuration: RawConfiguration): NetworkProxySettings {
  return {
    mode: normalizeNetworkProxyMode(configuration.get<unknown>('network.proxy.mode', 'auto')),
    url: String(configuration.get<unknown>('network.proxy.url', '') ?? '').trim()
  };
}

export function readMonitorSettings(configuration: RawConfiguration): MonitorSettings {
  const rooms = normalizeRoomIds(configuration.get<unknown[]>('rooms', []));
  return {
    rooms,
    groups: normalizeRoomGroups(configuration.get<unknown[]>('groups', []), rooms),
    autoRefreshEnabled: configuration.get<boolean>('autoRefresh.enabled', true),
    autoRefreshIntervalSeconds: clampAutoRefreshInterval(
      configuration.get<number>('autoRefresh.intervalSeconds', MIN_AUTO_REFRESH_INTERVAL_SECONDS)
    ),
    liveStartNotificationsEnabled: configuration.get<boolean>('notifications.liveStart.enabled', true)
  };
}

function sanitizeGroupId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
