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
  assert.match(styles, /\.peak-line/);
  assert.match(source, /plottableSeries\.length === 1/);
  assert.match(source, /'#3B82F6', '#22C55E', '#EAB308', '#EF4444'/);
});

test('history site declares cache, persistence, dual-day, and failure states', () => {
  assert.match(source, /cache: 'no-store'/);
  assert.match(source, /localStorage\.setItem/);
  assert.match(source, /midnight-line/);
  assert.match(source, /schemaVersion 1/);
  assert.match(source, /数据文件请求失败/);
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

  assert.match(source, /filters: new Set\(\['all'\]\)/);
  assert.match(source, /aggregates: new Set\(\)/);
  assert.match(source, /legacyScopes \?\? \['all'\]/);
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
