import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'styles.css'), 'utf8');

function extractFunction(startName: string, nextName: string): string {
  const start = source.indexOf(`function ${startName}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0, `${startName} is missing`);
  assert.ok(end > start, `${nextName} must follow ${startName}`);
  return source.slice(start, end);
}

test('history site keeps the plugin aggregate null and missing-sample rules', () => {
  const context = vm.createContext({});
  vm.runInContext(
    `function isFiniteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }\n${extractFunction('sumSeriesPoints', 'renderLegend')}`,
    context
  );
  const result = vm.runInContext(`sumSeriesPoints([
    { points: [[100, 10], [200, 20], [300, null]] },
    { points: [[200, 5], [300, 7]] }
  ])`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [[100, 10], [200, 25], [300, null]]);
});

test('history site room colors match plugin order with a stable fallback', () => {
  const colorContext = vm.createContext({ PALETTE: ['a', 'b', 'c', 'd', 'e'] });
  vm.runInContext(extractFunction('colorForRoom', 'buildYAxisScale'), colorContext);
  assert.equal(vm.runInContext(`colorForRoom('12345', 0)`, colorContext), 'a');
  assert.equal(vm.runInContext(`colorForRoom('54321', 1)`, colorContext), 'b');
  assert.equal(vm.runInContext(`colorForRoom('12345')`, colorContext), vm.runInContext(`colorForRoom('12345')`, colorContext));
  assert.notEqual(vm.runInContext(`colorForRoom('12345')`, colorContext), vm.runInContext(`colorForRoom('54321')`, colorContext));
});

test('history site date adjacency is timezone independent', () => {
  const dateContext = vm.createContext({});
  vm.runInContext(extractFunction('getNextDate', 'compareRoomIds'), dateContext);
  assert.equal(vm.runInContext(`getNextDate('2024-02-28')`, dateContext), '2024-02-29');
  assert.equal(vm.runInContext(`getNextDate('2026-12-31')`, dateContext), '2027-01-01');
  assert.equal(vm.runInContext(`areAdjacentDates('2026-08-23', '2026-08-24')`, dateContext), true);
});

test('history site dynamically scales the visible y range', () => {
  const context = vm.createContext({
    isFiniteNumber: (value: unknown) => typeof value === 'number' && Number.isFinite(value),
    clamp: (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
  });
  vm.runInContext(extractFunction('buildYAxisScale', 'svgLine'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('buildYAxisScale([0, 3200], 414)', context))), {
    min: 0, max: 3500, ticks: [0, 500, 1000, 1500, 2000, 2500, 3000, 3500]
  });
  const focused = JSON.parse(JSON.stringify(vm.runInContext('buildYAxisScale([2900, 3200], 414)', context)));
  assert.ok(focused.min > 0);
  assert.ok(focused.max - focused.min < 1000);
});

test('history site supports dark mode, plugin colors, and a single-series peak guide', () => {
  assert.match(html, /id="themeToggle"/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.match(styles, /prefers-color-scheme: dark/);
  assert.match(styles, /--bg:\s*#181818/);
  assert.match(styles, /--chart-bg:\s*#111213/);
  assert.match(styles, /--chart-blue:\s*#4daafc/);
  assert.match(styles, /\.chart-frame\s*\{[^}]*background:\s*var\(--chart-bg\)/s);
  assert.match(styles, /\.session-peak-chart\s*\{[^}]*background:\s*var\(--chart-bg\)/s);
  assert.match(styles, /\.session-peak-line\s*\{[^}]*stroke:\s*var\(--chart-blue\)/s);
  assert.match(styles, /\.session-peak-point\s*\{[^}]*fill:\s*var\(--chart-blue\)/s);
  assert.match(styles, /\.peak-line/);
  assert.match(source, /plottableSeries\.length === 1/);
  assert.match(source, /'#3B82F6', '#22C55E', '#EAB308', '#EF4444'/);
});

test('history site displays complete viewer counts without compact units', () => {
  const context = vm.createContext({ Intl });
  vm.runInContext(extractFunction('formatNumber', 'formatCompact'), context);
  assert.equal(vm.runInContext('formatNumber(1400)', context), '1,400');
  assert.equal(vm.runInContext('formatNumber(12345678)', context), '12,345,678');
  assert.doesNotMatch(extractFunction('renderChart', 'buildPath'), /formatCompact/);
  assert.match(source, /formatNumber\(value\), 'axis-label'/);
  assert.match(source, /`峰值 \$\{formatNumber\(peakValue\)\}`/);
});

test('history site declares cache, persistence, dual-day, and failure states', () => {
  assert.match(source, /cache: 'no-store'/);
  assert.match(source, /localStorage\.setItem/);
  assert.match(source, /midnight-line/);
  assert.match(source, /schemaVersion 2/);
  assert.match(source, /reference\.revision/);
  assert.match(source, /场次文件结构不兼容/);
  assert.doesNotMatch(source, /Math\.max\(\.\.\./);
});

test('history site restores defaults for missing, null, or broken local state', () => {
  const context = vm.createContext({});
  vm.runInContext(extractFunction('safeJson', 'restoreState'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(`safeJson(null, { value: 1 })`, context))), { value: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(`safeJson('null', { value: 2 })`, context))), { value: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(`safeJson('{', { value: 3 })`, context))), { value: 3 });
});

test('history site exposes explicit disconnected samples in the hover tooltip', () => {
  assert.match(source, /point\[1\] === null \? '断线'/);
});

test('history site mirrors the plugin range, aggregate, date, and session controls', () => {
  assert.match(html, /id="roomSelect"/);
  assert.match(html, /id="sessionSelect"/);
  assert.match(html, /id="clearSession"/);
  assert.match(html, /id="dateButtons"/);
  assert.match(html, /id="heightRange"/);
  assert.ok(html.indexOf('id="chartFrame"') < html.indexOf('id="legend"'));

  assert.match(source, /filters: new Set\(\['withData'\]\)/);
  assert.match(source, /aggregates: new Set\(\)/);
  assert.match(source, /legacyScopes \?\? \['withData'\]/);
  assert.match(source, /legacyScopes \?\? \[\]/);
  assert.match(source, /className = 'aggregate-scope-button'/);
  assert.match(source, /state\.filters\.has\(scope\.id\)/);
  assert.match(source, /state\.aggregates\.has\(scope\.id\)/);
  assert.match(source, /function selectHistoryDate/);
  assert.doesNotMatch(source, /restoreSessionVisibility/);
  assert.match(extractFunction('selectHistoryDate', 'loadSelectedDates'), /refs\.sessionSelect\.value = ''/);
  assert.doesNotMatch(extractFunction('selectHistoryDate', 'loadSelectedDates'), /state\.hidden\.clear/);
  assert.match(source, /function clearSessionFilter/);
});

test('history session focus drives ordinary filters without retaining a backup state', () => {
  const locateSource = extractFunction('locateSession', 'clearSessionFilter');
  const applySource = extractFunction('applySessionControls', 'updateRange');
  const clearSource = extractFunction('clearSessionFilter', 'applySessionControls');
  assert.match(locateSource, /session\.startMs - 5 \* 60_000/);
  assert.match(locateSource, /session\.endMs \+ 5 \* 60_000/);
  assert.match(locateSource, /applySessionControls\(\)/);
  assert.match(applySource, /state\.filters = new Set\(\['all'\]\)/);
  assert.match(applySource, /hidden\.add\('room:' \+ room\.roomId\)/);
  assert.match(applySource, /hidden\.add\('sum:' \+ scope\.id\)/);
  assert.doesNotMatch(clearSource, /state\.(filters|hidden)/);
  assert.doesNotMatch(source, /sessionHiddenBackup/);
  assert.match(styles, /\.legend-list \{ display: flex; flex-wrap: wrap/);
});
test('history site mirrors the VS Code session peak trend controls', () => {
  assert.match(html, /id="sessionPeakHeightRange"[^>]*min="160"[^>]*max="640"[^>]*step="10"/);
  assert.match(html, /id="sessionPeakHeightLabel"/);
  assert.match(html, /id="sessionPeakTrend"/);
  assert.ok(html.indexOf('id="sessionPeakHeightRange"') < html.indexOf('id="roomSelect"'));
  assert.match(source, /const SESSION_PEAK_RANGES = \[10, 30, 'all'\]/);
  assert.match(source, /sessionPeakRange: 30/);
  assert.match(source, /sessionPeakHeight: SESSION_PEAK_CHART_DEFAULT_HEIGHT/);
  assert.match(source, /sessionPeakPeriodColorEnabled: false/);
  assert.match(source, /function normalizeSessionPeakRange/);
  assert.match(source, /function clampSessionPeakHeight/);
  assert.match(source, /function getVisibleSessionPeakSessions/);
  assert.match(source, /SESSION_PEAK_CHART_DEFAULT_HEIGHT = 180/);
  assert.match(source, /SESSION_PEAK_CHART_MIN_WIDTH = 360/);
  assert.match(source, /state\.sessionPeakRange = range/);
  assert.match(source, /state\.sessionPeakHeight = clampSessionPeakHeight/);
  assert.match(source, /sessionPeakHeight: state\.sessionPeakHeight/);
  assert.match(source, /sessionPeakPeriodColorEnabled: state\.sessionPeakPeriodColorEnabled/);
  assert.match(source, /state\.sessionPeakPeriodColorEnabled = Boolean\(saved\.sessionPeakPeriodColorEnabled\)/);
  assert.match(source, /periodColorToggle\.setAttribute\('aria-pressed', String\(state\.sessionPeakPeriodColorEnabled\)\)/);
  assert.match(source, /state\.sessionPeakPeriodColorEnabled = !state\.sessionPeakPeriodColorEnabled/);
  assert.match(source, /if \(state\.sessionPeakPeriodColorEnabled\) \{\s*refs\.sessionPeakTrend\.append\(buildSessionPeakPeriodLegend\(\)\)/);
  assert.match(source, /point\.style\.fill = period\.color/);
  assert.match(source, /path\.setAttribute\('class', 'session-peak-line'\)/);
  assert.match(source, /buildSessionPeakNumberTicks\(maxPeak, plotHeight\)/);
  assert.match(source, /Math\.max\(4, Math\.min\(10, Math\.floor\(plotHeight \/ 36\)\)\)/);
  assert.match(source, /filterAxisTicksBySpacing\(ticks, 0, maxPeak, plotHeight, 24\)/);
  assert.match(source, /element\.style\.height = `\$\{state\.sessionPeakHeight\}px`/);
  assert.match(source, /chart\.style\.height = `\$\{state\.sessionPeakHeight\}px`/);
  assert.match(source, /tooltip\.offsetWidth \|\| 220/);
  assert.match(source, /aboveTop >= 8 \? aboveTop/);
  assert.match(source, /session-peak-point.*selected/);
  assert.match(source, /峰值在线人数/);
  assert.match(source, /直播时长/);
  assert.match(source, /时段分类 长场次（>= 4小时）/);
  assert.doesNotMatch(styles, /session-peak-scroll/);
  assert.match(styles, /\.session-peak-chart svg\s*\{[^}]*height:\s*100%/s);
  assert.match(styles, /\.session-peak-tooltip\s*\{[^}]*transform:\s*none/s);
  assert.doesNotMatch(styles, /\.session-peak-tooltip\.align-right/);
  assert.match(styles, /\.session-peak-point\.period-colored\.selected\s*\{[^}]*stroke-width:\s*3/s);
  assert.match(styles, /\.session-peak-period-legend\s*\{[^}]*flex-wrap:\s*wrap/s);

  const context = vm.createContext({
    Number,
    Math,
    SESSION_PEAK_CHART_DEFAULT_HEIGHT: 180
  });
  vm.runInContext(extractFunction('clampSessionPeakHeight', 'getVisibleSessionPeakSessions'), context);
  assert.equal(vm.runInContext('clampSessionPeakHeight(undefined)', context), 180);
  assert.equal(vm.runInContext('clampSessionPeakHeight(120)', context), 160);
  assert.equal(vm.runInContext('clampSessionPeakHeight(720)', context), 640);
});

test('history site classifies session peak periods in the exported timezone', () => {
  const periods = [
    { key: 'overnight', startMinute: 0, endMinute: 8 * 60 },
    { key: 'early', startMinute: 8 * 60, endMinute: 10 * 60 },
    { key: 'lateMorning', startMinute: 10 * 60, endMinute: 12 * 60 },
    { key: 'noon', startMinute: 12 * 60, endMinute: 14 * 60 },
    { key: 'afternoon', startMinute: 14 * 60, endMinute: 16 * 60 },
    { key: 'evening', startMinute: 16 * 60, endMinute: 18 * 60 },
    { key: 'primeOne', startMinute: 18 * 60, endMinute: 22 * 60 },
    { key: 'primeTwo', startMinute: 22 * 60, endMinute: 24 * 60 }
  ];
  const context = vm.createContext({
    Date,
    Intl,
    Number,
    Math,
    Object,
    state: { manifest: { timeZone: 'Asia/Shanghai' } },
    SESSION_PEAK_PERIODS: periods,
    SESSION_PEAK_LONG_PERIOD: { key: 'long' },
    SESSION_PEAK_LONG_DURATION_MS: 4 * 60 * 60 * 1000
  });
  vm.runInContext(
    extractFunction('getSessionPeakWallClockMs', 'renderSessionPeakTrend'),
    context
  );
  const classify = vm.runInContext('classifySessionPeakPeriod', context) as (
    session: { startMs: number; endMs: number; durationMs: number }
  ) => { key: string };
  const at = (day: number, hour: number, minute = 0, second = 0): number =>
    Date.UTC(2026, 0, day, hour - 8, minute, second);
  const pointSession = (hour: number, expectedKey: string): void => {
    const timestamp = at(5, hour);
    assert.equal(classify({ startMs: timestamp, endMs: timestamp, durationMs: 0 }).key, expectedKey);
  };

  pointSession(0, 'overnight');
  pointSession(8, 'early');
  pointSession(10, 'lateMorning');
  pointSession(12, 'noon');
  pointSession(14, 'afternoon');
  pointSession(16, 'evening');
  pointSession(18, 'primeOne');
  pointSession(22, 'primeTwo');

  assert.equal(classify({
    startMs: at(5, 9),
    endMs: at(5, 11, 30),
    durationMs: 2.5 * 60 * 60 * 1000
  }).key, 'lateMorning');
  assert.equal(classify({
    startMs: at(5, 8, 30),
    endMs: at(5, 11, 30),
    durationMs: 3 * 60 * 60 * 1000
  }).key, 'lateMorning');
  assert.equal(classify({
    startMs: at(5, 23),
    endMs: at(6, 2),
    durationMs: 3 * 60 * 60 * 1000
  }).key, 'overnight');
  assert.equal(classify({
    startMs: at(5, 8),
    endMs: at(5, 11, 59, 59),
    durationMs: 4 * 60 * 60 * 1000 - 1000
  }).key, 'early');
  assert.equal(classify({
    startMs: at(5, 8),
    endMs: at(5, 12),
    durationMs: 4 * 60 * 60 * 1000
  }).key, 'long');
  assert.equal(classify({
    startMs: at(5, 8),
    endMs: at(5, 12, 1),
    durationMs: 4 * 60 * 60 * 1000 + 60 * 1000
  }).key, 'long');
});

test('history site keeps the newest session peaks and sorts them chronologically', () => {
  const context = vm.createContext({
    isFiniteNumber: (value: unknown) => typeof value === 'number' && Number.isFinite(value)
  });
  vm.runInContext(extractFunction('normalizeSessionPeakRange', 'getVisibleSessionPeakSessions') + extractFunction('getVisibleSessionPeakSessions', 'renderSessionPeakTrend'), context);
  const sessions = Array.from({ length: 11 }, (_, index) => ({
    startMs: (index + 1) * 100,
    endMs: (index + 1) * 100 + 50
  })).reverse();
  const result = JSON.parse(JSON.stringify(vm.runInContext('getVisibleSessionPeakSessions(' + JSON.stringify(sessions) + ', 10)', context)));
  assert.deepEqual(result.map((session: { startMs: number }) => session.startMs), [200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
  assert.equal(vm.runInContext("normalizeSessionPeakRange('bad')", context), 30);
  assert.equal(vm.runInContext("normalizeSessionPeakRange('all')", context), 'all');
});

test('history site limits room requests to eight concurrent tasks', async () => {
  const context = vm.createContext({ Promise });
  vm.runInContext('async ' + extractFunction('runWithConcurrency', 'isAbortError'), context);
  let active = 0;
  let maximum = 0;
  const tasks = Array.from({ length: 24 }, () => async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  });
  context.tasks = tasks;
  await vm.runInContext('runWithConcurrency(tasks, 8, () => {})', context);
  assert.equal(maximum, 8);
  assert.match(source, /const MAX_CONCURRENT_REQUESTS = 8/);
});

test('history site downsampling preserves endpoints, extrema, and disconnect boundaries', () => {
  const context = vm.createContext({
    isFiniteNumber: (value: unknown) => typeof value === 'number' && Number.isFinite(value),
    clamp: (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
  });
  vm.runInContext(extractFunction('downsamplePoints', 'showTooltip'), context);
  const points: Array<[number, number | null]> = Array.from(
    { length: 1000 },
    (_, index) => [index, index === 537 ? 9999 : index % 17] as [number, number]
  );
  points.splice(600, 0, [600, null]);
  context.points = points;
  const result = JSON.parse(JSON.stringify(vm.runInContext('downsamplePoints(points, 0, 999, 50)', context))) as Array<[number, number | null]>;
  assert.deepEqual(result[0], [0, 0]);
  assert.deepEqual(result.at(-1), [999, 13]);
  assert.ok(result.some((point) => point[0] === 537 && point[1] === 9999));
  assert.ok(result.some((point) => point[1] === null));
  assert.ok(result.length <= 50 * 4 + 1);
});

test('history site v2 uses indexed active rooms first and upgrades v1 filters', () => {
  assert.match(source, /const LEGACY_STORAGE_KEY = 'bwatch\.historySite\.state\.v1'/);
  assert.match(source, /legacy \? \['withData'\]/);
  assert.match(source, /file\.idleRoomIds\.some\(\(roomId\) => requiredRoomIds\.has\(roomId\)/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /state\.loadController\?\.abort\(\)/);
  assert.match(source, /state\.fileCache\.has\(cacheKey\)/);
  assert.match(source, /Promise\.all\(metadata\.map/);
});
