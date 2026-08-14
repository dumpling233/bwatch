export function formatLiveDuration(liveStartTimeSeconds: number | null, nowMs = Date.now()): string {
  if (!liveStartTimeSeconds) {
    return '未开播';
  }

  const elapsedSeconds = Math.max(0, Math.floor(nowMs / 1000) - liveStartTimeSeconds);
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return `${hours}小时${minutes}分钟`;
  }

  if (minutes > 0) {
    return `${minutes}分钟${seconds}秒`;
  }

  return `${seconds}秒`;
}

export function formatUpdatedAt(timestampMs: number | null): string {
  if (!timestampMs) {
    return '-';
  }

  const date = new Date(timestampMs);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}
