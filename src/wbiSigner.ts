import { createHash } from 'node:crypto';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13
];

const WBI_FILTER_PATTERN = /[!'()*]/g;

export function extractWbiKey(imgUrl: string, subUrl: string): string {
  const source = `${extractFileStem(imgUrl)}${extractFileStem(subUrl)}`;
  return MIXIN_KEY_ENC_TAB.map((index) => source[index] ?? '').join('');
}

export function signWbiParams(
  params: Record<string, string | number>,
  wbiKey: string,
  nowMs = Date.now()
): URLSearchParams {
  const signedParams: Record<string, string> = {
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
    wts: String(Math.floor(nowMs / 1000))
  };
  const query = new URLSearchParams();

  for (const key of Object.keys(signedParams).sort()) {
    query.set(key, signedParams[key].replace(WBI_FILTER_PATTERN, ''));
  }

  const wRid = createHash('md5').update(`${query.toString()}${wbiKey}`).digest('hex');
  query.set('w_rid', wRid);
  return query;
}

function extractFileStem(value: string): string {
  try {
    const pathname = new URL(value).pathname;
    const fileName = pathname.slice(pathname.lastIndexOf('/') + 1);
    return fileName.slice(0, fileName.lastIndexOf('.')) || fileName;
  } catch {
    const fileName = value.slice(value.lastIndexOf('/') + 1);
    return fileName.slice(0, fileName.lastIndexOf('.')) || fileName;
  }
}
