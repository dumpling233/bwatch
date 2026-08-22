import { execFile } from 'node:child_process';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { NetworkProxyMode, NetworkProxySettings } from './types';

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface ProxySource {
  mode: NetworkProxyMode;
  manualProxyUrl?: string;
  vscodeProxyUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedProxy {
  mode: NetworkProxyMode;
  url: string | null;
  source: 'manual' | 'vscode' | 'environment' | 'off' | 'none';
}

const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const LOCAL_PROXY_FALLBACK_TIMEOUT_MS = 4_000;
const LOCAL_PROXY_FALLBACK_URLS = ['http://127.0.0.1:7897', 'http://127.0.0.1:7890', 'http://127.0.0.1:10809'];

export function getAutoLocalProxyUrls(): readonly string[] {
  return LOCAL_PROXY_FALLBACK_URLS;
}

export function resolveProxy(source: ProxySource): ResolvedProxy {
  const mode = source.mode;
  if (mode === 'off') {
    return { mode, url: null, source: 'off' };
  }

  if (mode === 'manual') {
    const url = normalizeProxyUrl(source.manualProxyUrl);
    return { mode, url, source: url ? 'manual' : 'none' };
  }

  const vscodeProxyUrl = normalizeProxyUrl(source.vscodeProxyUrl);
  if (vscodeProxyUrl) {
    return { mode, url: vscodeProxyUrl, source: 'vscode' };
  }

  const envProxyUrl = resolveProxyFromEnv(source.env ?? process.env);
  return {
    mode,
    url: envProxyUrl,
    source: envProxyUrl ? 'environment' : 'none'
  };
}

export function createProxyFetch(proxy: ResolvedProxy, baseFetch: FetchLike = fetch): FetchLike {
  if (proxy.url) {
    return async (input, init) => {
      try {
        return await fetchThroughProxyCandidate(input, init, proxy.url as string, DEFAULT_REQUEST_TIMEOUT_MS);
      } catch (error) {
        if (proxy.mode !== 'auto') {
          throw error;
        }
        return fetchThroughAutoLocalProxyCandidates(input, init, error);
      }
    };
  }

  return async (input, init) => {
    try {
      return await fetchWithTimeout(baseFetch, input, init, DEFAULT_REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (proxy.mode !== 'auto' || !shouldTryLocalProxyFallback(error)) {
        throw error;
      }

      return fetchThroughAutoLocalProxyCandidates(input, init, error);
    }
  };
}

export function createBwatchFetch(
  settings: NetworkProxySettings,
  vscodeProxyUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
  baseFetch: FetchLike = fetch
): FetchLike {
  return createProxyFetch(
    resolveProxy({
      mode: settings.mode,
      manualProxyUrl: settings.url,
      vscodeProxyUrl,
      env
    }),
    baseFetch
  );
}

export function formatNetworkError(error: unknown): string {
  if (!(error instanceof Error)) {
    return '网络请求失败';
  }

  const cause = getErrorCause(error);
  const detail = stringifyErrorDetail(cause ?? error);
  const code = getErrorCode(cause ?? error);
  const address = getErrorAddress(cause ?? error);
  const port = getErrorPort(cause ?? error);
  const endpoint = address && port ? `${address}:${port}` : address;

  if (error.name === 'AbortError' || /aborted|timeout|timed out/i.test(detail)) {
    return `网络连接超时${endpoint ? `：${endpoint}` : ''}`;
  }

  if (code === 'EACCES' || /EACCES/i.test(detail)) {
    if (address?.startsWith('198.18.') || /198\.18\./.test(detail)) {
      return `网络请求被当前代理/fake-ip 链路拦截或拒绝：${endpoint ?? address ?? detail}。请检查 VSCode 代理设置或 BWatch 代理配置`;
    }
    return `网络连接被拒绝或无权限访问${endpoint ? `：${endpoint}` : ''}`;
  }

  if (/SSL|TLS|certificate|handshake|CERT_/i.test(detail)) {
    return `TLS/证书握手失败：${detail}`;
  }

  if (code === 'ECONNREFUSED') {
    return `代理或目标服务拒绝连接${endpoint ? `：${endpoint}` : ''}`;
  }

  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `网络连接超时${endpoint ? `：${endpoint}` : ''}`;
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `域名解析失败：${detail}`;
  }

  if (error.message === 'fetch failed' && detail && detail !== error.message) {
    return `网络请求失败：${detail}`;
  }

  return error.message || '网络请求失败';
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string | URL,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sourceSignal = init?.signal;
  const abort = () => controller.abort();

  if (sourceSignal?.aborted) {
    controller.abort();
  } else {
    sourceSignal?.addEventListener('abort', abort, { once: true });
  }

  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    sourceSignal?.removeEventListener('abort', abort);
  }
}

function fetchThroughProxy(
  input: string | URL,
  init: RequestInit | undefined,
  proxyUrl: string,
  timeoutMs: number
): Promise<Response> {
  const targetUrl = new URL(String(input));
  const proxy = new URL(proxyUrl);

  if (targetUrl.protocol === 'https:') {
    return fetchHttpsThroughProxy(targetUrl, init, proxy, timeoutMs);
  }

  if (targetUrl.protocol === 'http:') {
    return fetchHttpThroughProxy(targetUrl, init, proxy, timeoutMs);
  }

  return Promise.reject(new Error(`不支持的请求协议：${targetUrl.protocol}`));
}

async function fetchThroughProxyCandidate(
  input: string | URL,
  init: RequestInit | undefined,
  proxyUrl: string,
  timeoutMs: number
): Promise<Response> {
  try {
    return await fetchThroughProxy(input, init, proxyUrl, timeoutMs);
  } catch (proxyError) {
    if (!shouldTryCurlFallback(proxyError)) {
      throw proxyError;
    }

    try {
      return await fetchWithCurl(input, init, timeoutMs, proxyUrl);
    } catch (curlError) {
      throw new Error(
        `通过代理 ${redactProxyUrl(proxyUrl)} 请求失败：${formatNetworkError(proxyError)}；curl 兜底也失败：${formatNetworkError(
          curlError
        )}`
      );
    }
  }
}

async function fetchThroughAutoLocalProxyCandidates(
  input: string | URL,
  init: RequestInit | undefined,
  originalError: unknown
): Promise<Response> {
  const proxyErrors: string[] = [];
  for (const fallbackProxyUrl of LOCAL_PROXY_FALLBACK_URLS) {
    try {
      return await fetchThroughProxyCandidate(input, init, fallbackProxyUrl, LOCAL_PROXY_FALLBACK_TIMEOUT_MS);
    } catch (proxyError) {
      proxyErrors.push(`${redactProxyUrl(fallbackProxyUrl)} => ${formatNetworkError(proxyError)}`);
      // Keep trying the next common local HTTP proxy port.
    }
  }

  let directCurlError: string | undefined;
  try {
    return await fetchWithCurl(input, init, DEFAULT_REQUEST_TIMEOUT_MS);
  } catch (error) {
    directCurlError = formatNetworkError(error);
  }

  if (proxyErrors.length > 0) {
    throw new Error(
      `${formatNetworkError(originalError)}；已尝试本地代理候选：${proxyErrors.join('；')}；` +
        `直连 curl 兜底失败：${directCurlError ?? 'unknown'}`
    );
  }

  throw originalError;
}

function fetchWithCurl(
  input: string | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  proxyUrl?: string
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const statusMarker = '__BWATCH_HTTP_STATUS__:';
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const args = [
      '--silent',
      '--show-error',
      '--http1.1',
      '--location',
      '--connect-timeout',
      String(timeoutSeconds),
      '--max-time',
      String(timeoutSeconds),
      '--write-out',
      `\n${statusMarker}%{http_code}`,
      '--request',
      init?.method ?? 'GET'
    ];

    if (proxyUrl) {
      args.push('--proxy', proxyUrl);
    }

    for (const [key, value] of Object.entries(normalizeHeaders(init?.headers))) {
      args.push('--header', `${key}: ${value}`);
    }

    const body = normalizeRequestBody(init?.body);
    if (body !== undefined) {
      args.push('--data-binary', body);
    }

    args.push(String(input));

    const child = execFile(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
      windowsHide: true,
      timeout: timeoutMs + 1000,
      maxBuffer: 4 * 1024 * 1024
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const abort = () => {
      child.kill();
      reject(new Error('请求已取消'));
    };

    if (init?.signal?.aborted) {
      abort();
      return;
    }

    init?.signal?.addEventListener('abort', abort, { once: true });
    child.once('exit', () => init?.signal?.removeEventListener('abort', abort));
    child.once('error', reject);
    child.once('close', (code) => {
      init?.signal?.removeEventListener('abort', abort);
      const markerIndex = stdout.lastIndexOf(statusMarker);
      if (code !== 0 || markerIndex < 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `curl 请求失败，退出码 ${code ?? 'unknown'}`));
        return;
      }

      const bodyText = stdout.slice(0, markerIndex).replace(/\r?\n$/, '');
      const status = Number(stdout.slice(markerIndex + statusMarker.length).trim());
      if (!Number.isFinite(status) || status <= 0) {
        reject(new Error(stderr.trim() || `curl 未返回有效 HTTP 状态：${stdout.slice(markerIndex + statusMarker.length).trim()}`));
        return;
      }

      resolve(new Response(bodyText, { status }));
    });
  });
}

async function fetchHttpsThroughProxy(
  targetUrl: URL,
  init: RequestInit | undefined,
  proxy: URL,
  timeoutMs: number
): Promise<Response> {
  const targetPort = getTargetPort(targetUrl);
  const socket = await connectHttpsTunnel(proxy, targetUrl.hostname, targetPort, timeoutMs);
  return new Promise((resolve, reject) => {
    const cleanupFns: Array<() => void> = [];

    const request = https.request(
      {
        hostname: targetUrl.hostname,
        port: targetPort,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: init?.method ?? 'GET',
        headers: normalizeHeaders(init?.headers),
        createConnection: () => socket,
        agent: false
      },
      (response) => collectResponse(response, resolve, reject)
    );

    wireRequestLifecycle(request, init?.signal, timeoutMs, cleanupFns, reject);
    writeRequestBody(request, init?.body);
  });
}

function fetchHttpThroughProxy(
  targetUrl: URL,
  init: RequestInit | undefined,
  proxy: URL,
  timeoutMs: number
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const cleanupFns: Array<() => void> = [];
    const client = proxy.protocol === 'https:' ? https : http;
    const request = client.request(
      {
        hostname: proxy.hostname,
        port: getProxyPort(proxy),
        path: targetUrl.toString(),
        method: init?.method ?? 'GET',
        headers: {
          ...normalizeHeaders(init?.headers),
          host: targetUrl.host,
          ...createProxyAuthorizationHeader(proxy)
        }
      },
      (response) => collectResponse(response, resolve, reject)
    );

    wireRequestLifecycle(request, init?.signal, timeoutMs, cleanupFns, reject);
    writeRequestBody(request, init?.body);
  });
}

function connectHttpsTunnel(proxy: URL, targetHost: string, targetPort: number, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = proxy.protocol === 'https:' ? https : http;
    const target = `${targetHost}:${targetPort}`;
    const request = client.request({
      hostname: proxy.hostname,
      port: getProxyPort(proxy),
      method: 'CONNECT',
      path: target,
      headers: {
        host: target,
        ...createProxyAuthorizationHeader(proxy)
      },
      timeout: timeoutMs
    });

    const finish = (error?: Error, socket?: tls.TLSSocket) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        request.destroy();
        reject(error);
      } else if (socket) {
        resolve(socket);
      }
    };

    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`代理 CONNECT 返回 HTTP ${response.statusCode ?? 'unknown'}`));
        return;
      }

      const tlsSocket = tls.connect({ socket, servername: targetHost }, () => finish(undefined, tlsSocket));
      tlsSocket.once('error', finish);
    });
    request.once('timeout', () => finish(new Error(`代理连接超时：${proxy.host}`)));
    request.once('error', finish);
    request.end();
  });
}

function collectResponse(
  response: http.IncomingMessage,
  resolve: (value: Response) => void,
  reject: (reason?: unknown) => void
): void {
  const chunks: Buffer[] = [];
  response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  response.once('error', reject);
  response.once('end', () => {
    resolve(
      new Response(Buffer.concat(chunks), {
        status: response.statusCode ?? 599,
        statusText: response.statusMessage,
        headers: normalizeResponseHeaders(response.headers)
      })
    );
  });
}

function wireRequestLifecycle(
  request: http.ClientRequest,
  signal: AbortSignal | null | undefined,
  timeoutMs: number,
  cleanupFns: Array<() => void>,
  reject: (reason?: unknown) => void
): void {
  const abort = () => request.destroy(new Error('请求已取消'));
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener('abort', abort, { once: true });
    if (signal) {
      cleanupFns.push(() => signal.removeEventListener('abort', abort));
    }
  }

  request.setTimeout(timeoutMs, () => request.destroy(new Error('请求超时')));
  request.once('error', reject);
  request.once('close', () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
  });
}

function writeRequestBody(request: http.ClientRequest, body: BodyInit | null | undefined): void {
  if (body === undefined || body === null) {
    request.end();
    return;
  }

  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    request.end(body);
    return;
  }

  if (body instanceof URLSearchParams) {
    request.end(body.toString());
    return;
  }

  request.end();
}

function normalizeRequestBody(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return body.toString();
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  return undefined;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) {
    return result;
  }

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
    return result;
  }

  for (const [key, value] of Object.entries(headers)) {
    result[key] = String(value);
  }

  return result;
}

function normalizeResponseHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      result.set(key, value.join(', '));
    } else if (typeof value === 'string') {
      result.set(key, value);
    }
  }
  return result;
}

function createProxyAuthorizationHeader(proxy: URL): Record<string, string> {
  if (!proxy.username) {
    return {};
  }

  const token = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
  return {
    'proxy-authorization': `Basic ${token}`
  };
}

function getProxyPort(proxy: URL): number {
  if (proxy.port) {
    return Number(proxy.port);
  }
  return proxy.protocol === 'https:' ? 443 : 80;
}

function getTargetPort(targetUrl: URL): number {
  if (targetUrl.port) {
    return Number(targetUrl.port);
  }
  return targetUrl.protocol === 'https:' ? 443 : 80;
}

function shouldTryLocalProxyFallback(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const cause = getErrorCause(error);
  const detail = stringifyErrorDetail(cause ?? error);
  const code = getErrorCode(cause ?? error);
  const address = getErrorAddress(cause ?? error);
  return (
    ((code === 'EACCES' || /EACCES/i.test(detail)) && (address?.startsWith('198.18.') || /198\.18\./.test(detail))) ||
    /SSL|TLS|certificate|handshake|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(detail)
  );
}

function shouldTryCurlFallback(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const cause = getErrorCause(error);
  const detail = stringifyErrorDetail(cause ?? error);
  const code = getErrorCode(cause ?? error);
  return code === 'EACCES' || /EACCES|SSL|TLS|certificate|handshake|ECONNREFUSED|ETIMEDOUT|198\.18\./i.test(detail);
}

function normalizeProxyUrl(value: unknown): string | null {
  const url = String(value ?? '').trim();
  if (!url) {
    return null;
  }

  if (!/^https?:\/\//i.test(url)) {
    return null;
  }

  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

function resolveProxyFromEnv(env: NodeJS.ProcessEnv): string | null {
  return normalizeProxyUrl(env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy);
}

function redactProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) {
      url.username = '***';
    }
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return value;
  }
}

function getErrorCause(error: Error): unknown {
  return (error as Error & { cause?: unknown }).cause;
}

function stringifyErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function getErrorAddress(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'address' in error) {
    const address = (error as { address?: unknown }).address;
    return typeof address === 'string' ? address : undefined;
  }
  return undefined;
}

function getErrorPort(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'port' in error) {
    const port = (error as { port?: unknown }).port;
    return typeof port === 'number' ? port : undefined;
  }
  return undefined;
}
