import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'app.js'), 'utf8');

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

test('history site room colors are stable and date adjacency is timezone independent', () => {
  const colorContext = vm.createContext({ PALETTE: ['a', 'b', 'c', 'd', 'e'] });
  vm.runInContext(extractFunction('colorForRoom', 'niceMax'), colorContext);
  assert.equal(vm.runInContext(`colorForRoom('12345')`, colorContext), vm.runInContext(`colorForRoom('12345')`, colorContext));
  assert.notEqual(vm.runInContext(`colorForRoom('12345')`, colorContext), vm.runInContext(`colorForRoom('54321')`, colorContext));

  const dateContext = vm.createContext({});
  vm.runInContext(extractFunction('getNextDate', 'compareRoomIds'), dateContext);
  assert.equal(vm.runInContext(`getNextDate('2024-02-28')`, dateContext), '2024-02-29');
  assert.equal(vm.runInContext(`getNextDate('2026-12-31')`, dateContext), '2027-01-01');
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
