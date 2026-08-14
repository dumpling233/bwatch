import { FetchLike, ResolvedProxy, formatNetworkError, getAutoLocalProxyUrls } from './network';

export interface NetworkDiagnosticResult {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  bilibiliCode?: number;
  message: string;
  elapsedMs: number;
}

export interface NetworkDiagnosticReport {
  checkedAt: number;
  proxy: ResolvedProxy;
  results: NetworkDiagnosticResult[];
}

interface DiagnosticEndpoint {
  name: string;
  url: string;
}

const DIAGNOSTIC_ENDPOINTS: DiagnosticEndpoint[] = [
  {
    name: '基础房间信息',
    url: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo?req_biz=web_room_componet&room_ids=1&attrs=room_id,short_id,uid,title,uname,live_status,live_time,online'
  },
  {
    name: '在线人数',
    url: 'https://api.live.bilibili.com/xlive/general-interface/v1/rank/getOnlineGoldRank?ruid=9617619&roomId=5440&page=1&pageSize=1'
  },
  {
    name: '舰队人数',
    url: 'https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList?roomid=5440&ruid=9617619&page=1&page_size=1'
  },
  {
    name: '粉丝数',
    url: 'https://api.bilibili.com/x/relation/stat?vmid=2'
  },
  {
    name: '主播搜索',
    url: 'https://api.bilibili.com/x/web-interface/search/type?search_type=live_user&keyword=%E7%9B%B4%E6%92%AD&page=1&page_size=1&order=online&platform=pc'
  }
];

export async function runNetworkDiagnostics(fetchImpl: FetchLike, proxy: ResolvedProxy): Promise<NetworkDiagnosticReport> {
  const results: NetworkDiagnosticResult[] = [];
  for (const endpoint of DIAGNOSTIC_ENDPOINTS) {
    results.push(await diagnoseEndpoint(fetchImpl, endpoint));
  }

  return {
    checkedAt: Date.now(),
    proxy,
    results
  };
}

function formatDiagnosticReport(report: NetworkDiagnosticReport): string {
  const lines = [
    `BWatch 网络诊断 - ${new Date(report.checkedAt).toLocaleString('zh-CN')}`,
    `代理模式：${report.proxy.mode}`,
    `代理来源：${report.proxy.source}`,
    `代理地址：${report.proxy.url ?? '未使用代理'}`,
    `auto 本地代理候选：${report.proxy.mode === 'auto' && !report.proxy.url ? getAutoLocalProxyUrls().join(', ') : '-'}`,
    ''
  ];

  for (const result of report.results) {
    lines.push(
      `[${result.ok ? 'OK' : 'FAIL'}] ${result.name} (${result.elapsedMs}ms)`,
      `  URL: ${result.url}`,
      `  HTTP: ${result.status ?? '-'}`,
      `  B站 code: ${result.bilibiliCode ?? '-'}`,
      `  结果: ${result.message}`,
      ''
    );
  }

  return lines.join('\n');
}

export function writeNetworkDiagnosticReport(
  output: { appendLine(value: string): void; clear(): void; show(): void },
  report: NetworkDiagnosticReport
): void {
  output.clear();
  output.appendLine(formatDiagnosticReport(report));
  output.show();
}

async function diagnoseEndpoint(fetchImpl: FetchLike, endpoint: DiagnosticEndpoint): Promise<NetworkDiagnosticResult> {
  const startMs = Date.now();
  try {
    const response = await fetchImpl(endpoint.url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        referer: endpoint.url.includes('search/type')
          ? 'https://search.bilibili.com/live?keyword=%E7%9B%B4%E6%92%AD'
          : 'https://live.bilibili.com/',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      }
    });
    const elapsedMs = Date.now() - startMs;
    const text = await response.text();
    const payload = safeParseJson(text);
    const bilibiliCode = readBilibiliCode(payload);
    const payloadMessage = readBilibiliMessage(payload);
    const ok = response.ok && (bilibiliCode === undefined || bilibiliCode === 0);

    return {
      name: endpoint.name,
      url: endpoint.url,
      ok,
      status: response.status,
      bilibiliCode,
      message: ok ? '接口可访问' : payloadMessage || `接口返回异常${response.ok ? '' : `，HTTP ${response.status}`}`,
      elapsedMs
    };
  } catch (error) {
    return {
      name: endpoint.name,
      url: endpoint.url,
      ok: false,
      message: formatNetworkError(error),
      elapsedMs: Date.now() - startMs
    };
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readBilibiliCode(payload: unknown): number | undefined {
  if (payload && typeof payload === 'object' && 'code' in payload) {
    const code = (payload as { code?: unknown }).code;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

function readBilibiliMessage(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && 'message' in payload) {
    const message = (payload as { message?: unknown }).message;
    return typeof message === 'string' && message ? message : undefined;
  }
  return undefined;
}
