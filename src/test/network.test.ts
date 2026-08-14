import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNetworkError, getAutoLocalProxyUrls, resolveProxy } from '../network';

test('resolveProxy auto mode prefers VSCode http proxy', () => {
  assert.deepEqual(
    resolveProxy({
      mode: 'auto',
      vscodeProxyUrl: 'http://127.0.0.1:7890',
      env: {
        HTTPS_PROXY: 'http://127.0.0.1:7891'
      }
    }),
    {
      mode: 'auto',
      url: 'http://127.0.0.1:7890/',
      source: 'vscode'
    }
  );
});

test('resolveProxy auto mode falls back to environment proxy', () => {
  assert.deepEqual(
    resolveProxy({
      mode: 'auto',
      vscodeProxyUrl: '',
      env: {
        HTTPS_PROXY: 'http://127.0.0.1:7891'
      }
    }),
    {
      mode: 'auto',
      url: 'http://127.0.0.1:7891/',
      source: 'environment'
    }
  );
});

test('resolveProxy manual mode uses BWatch proxy URL', () => {
  assert.deepEqual(
    resolveProxy({
      mode: 'manual',
      manualProxyUrl: 'http://127.0.0.1:7892',
      vscodeProxyUrl: 'http://127.0.0.1:7890',
      env: {
        HTTPS_PROXY: 'http://127.0.0.1:7891'
      }
    }),
    {
      mode: 'manual',
      url: 'http://127.0.0.1:7892/',
      source: 'manual'
    }
  );
});

test('resolveProxy off mode disables proxy', () => {
  assert.deepEqual(
    resolveProxy({
      mode: 'off',
      manualProxyUrl: 'http://127.0.0.1:7892',
      vscodeProxyUrl: 'http://127.0.0.1:7890',
      env: {
        HTTPS_PROXY: 'http://127.0.0.1:7891'
      }
    }),
    {
      mode: 'off',
      url: null,
      source: 'off'
    }
  );
});

test('auto local proxy candidates prefer Clash Verge default port', () => {
  assert.deepEqual(getAutoLocalProxyUrls(), [
    'http://127.0.0.1:7897',
    'http://127.0.0.1:7890',
    'http://127.0.0.1:10809'
  ]);
});

test('formatNetworkError explains EACCES fake-ip failures', () => {
  const error = new Error('fetch failed') as Error & { cause?: unknown };
  error.cause = Object.assign(new Error('connect EACCES 198.18.0.149:443'), {
    code: 'EACCES',
    address: '198.18.0.149',
    port: 443
  });

  assert.match(formatNetworkError(error), /代理\/fake-ip|198\.18\.0\.149:443/);
});
