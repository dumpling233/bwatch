import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

class FakeClassList {
  toggle(): void {}
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly style: Record<string, string> = {};
  type = '';
  className = '';
  title = '';
  textContent = '';

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  setAttribute(): void {}

  addEventListener(): void {}
}

function readWebviewSource(): string {
  return fs.readFileSync(path.resolve(__dirname, '../../media/webview.js'), 'utf8');
}

function readWebviewProviderSource(): string {
  return fs.readFileSync(path.resolve(__dirname, '../../src/webviewProvider.ts'), 'utf8');
}

function extractFunction(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`  function ${name}`);
  const end = source.indexOf(`\n  function ${nextName}`, start);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing boundary after ${name}`);
  return source.slice(start, end);
}

test('overview legend sorts latest online values without breaking chart rendering', () => {
  const source = readWebviewSource();
  const buildOverviewSvgSource = extractFunction(source, 'buildOverviewSvg', 'overviewLegend');
  assert.doesNotMatch(buildOverviewSvgSource, /sortedSeries|findLatestValidPoint/);

  const context = vm.createContext({
    document: {
      createElement: () => new FakeElement()
    },
    Intl
  });
  vm.runInContext(
    `${extractFunction(source, 'overviewLegend', 'toggleOverviewSeries')}\n`
      + `${extractFunction(source, 'findLatestValidPoint', 'textSpan')}\n`
      + `${extractFunction(source, 'formatNumber', 'formatNullableNumber')}`,
    context
  );

  const series = [
    { room: { roomId: 'low', anchorName: '低' }, color: 'blue', points: [[1, 100], [2, 200]] },
    { room: { roomId: 'missing', anchorName: '无数据' }, color: 'gray', points: [[1, null]] },
    { room: { roomId: 'high', anchorName: '高' }, color: 'red', points: [[1, 300], [2, 500]] }
  ];
  const legend = vm.runInContext('overviewLegend', context)(series, new Set<string>(), () => undefined) as FakeElement;
  const values = legend.children.map((entry) => entry.children[2].textContent);
  assert.deepEqual(values, ['500', '200', '--']);
});

test('trend range selection merges multiple scopes without duplicate rooms', () => {
  const source = readWebviewSource();
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, 'mergeRoomsForScopes', 'roomHasValidOverviewPoint'), context);

  const rooms = [
    { roomId: '1' },
    { roomId: '2' },
    { roomId: '3' }
  ];
  const scopes = new Set(['all', 'group:a']);
  const roomsByScope: Record<string, Array<{ roomId: string }>> = {
    all: rooms,
    'group:a': [rooms[1], rooms[2]]
  };
  const merged = vm.runInContext('mergeRoomsForScopes', context)(
    rooms,
    scopes,
    (scope: string) => roomsByScope[scope]
  ) as Array<{ roomId: string }>;

  assert.deepEqual(Array.from(merged, (room) => room.roomId), ['1', '2', '3']);
});

test('trend range selection does not reset aggregate or legend state', () => {
  const source = readWebviewSource();
  const overviewButtonSource = extractFunction(source, 'overviewModeButton', 'aggregateScopeButton');
  const historyButtonSource = extractFunction(source, 'historyModeButton', 'appendScopeControl');

  assert.doesNotMatch(overviewButtonSource, /clearAggregateScopes|overviewHiddenRoomIds\.clear/);
  assert.doesNotMatch(historyButtonSource, /clearAggregateScopes|historyHiddenRoomIds\.clear/);
});

test('persisted trend ranges migrate legacy single selection and preserve empty multi-selection', () => {
  const source = readWebviewSource();
  const context = vm.createContext({
    isValidPersistedScope: (scope: unknown, builtInScopes: string[]) =>
      typeof scope === 'string' && (builtInScopes.includes(scope) || scope.startsWith('group:'))
  });
  vm.runInContext(extractFunction(source, 'normalizePersistedRangeScopes', 'normalizePersistedHistoryRange'), context);
  const normalize = vm.runInContext('normalizePersistedRangeScopes', context) as (
    scopes: unknown,
    legacyScope: unknown,
    builtInScopes: string[]
  ) => string[];

  assert.deepEqual(Array.from(normalize(undefined, 'live', ['all', 'live'])), ['live']);
  assert.deepEqual(Array.from(normalize([], 'live', ['all', 'live'])), []);
  assert.deepEqual(Array.from(normalize(undefined, undefined, ['all', 'live'])), ['all']);
  assert.deepEqual(Array.from(normalize(['all', 'group:a', 'all'], undefined, ['all', 'live'])), ['all', 'group:a']);
});

test('aggregate trend labels include live and total room counts for their own scope', () => {
  const source = readWebviewSource();
  const context = vm.createContext({
    getScopeLabel: () => '中坚'
  });
  vm.runInContext(extractFunction(source, 'getAggregateSeriesLabel', 'getAggregateSeriesId'), context);
  const getLabel = vm.runInContext('getAggregateSeriesLabel', context) as (
    scope: string,
    roomSeries: Array<{ room: { roomId: string } }>,
    snapshot: { rooms: Array<{ roomId: string; status: string }> }
  ) => string;

  const label = getLabel(
    'group:a',
    [{ room: { roomId: '1' } }, { room: { roomId: '2' } }, { room: { roomId: '3' } }],
    { rooms: [{ roomId: '1', status: 'live' }, { roomId: '2', status: 'offline' }, { roomId: '3', status: 'live' }] }
  );

  assert.equal(label, '中坚合计 2/3');
  assert.match(extractFunction(source, 'buildAggregateSeries', 'getAggregateSeriesLabel'), /getAggregateSeriesLabel/);
});

test('aggregate trend sums historical points when a group member was added later', () => {
  const source = readWebviewSource();
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, 'sumSeriesPoints', 'getScopeLabel'), context);
  const sum = vm.runInContext('sumSeriesPoints', context) as (
    roomSeries: Array<{ points: Array<[number, number | null]> }>
  ) => Array<[number, number | null]>;

  assert.deepEqual(JSON.parse(JSON.stringify(sum([
    { points: [[100, 10], [200, 20], [300, null]] },
    { points: [[200, 5], [300, 7]] }
  ]))), [
    [100, 10],
    [200, 25],
    [300, null]
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(sum([
    { points: [[100, null]] },
    { points: [] }
  ]))), [[100, null]]);
});

test('trend scope labels include live and actual filtered room counts', () => {
  const source = readWebviewSource();
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, 'getScopeStatusLabel', 'getAggregateSeriesId'), context);
  const getLabel = vm.runInContext('getScopeStatusLabel', context) as (
    label: string,
    rooms: Array<{ roomId: string }>,
    snapshot: { rooms: Array<{ roomId: string; status: string }> }
  ) => string;

  const label = getLabel(
    '有数据',
    [{ roomId: '1' }, { roomId: '3' }],
    { rooms: [{ roomId: '1', status: 'live' }, { roomId: '2', status: 'live' }, { roomId: '3', status: 'offline' }] }
  );

  assert.equal(label, '有数据 1/2');
  assert.match(extractFunction(source, 'appendScopeControl', 'appendGroupScopeControls'), /getScopeStatusLabel/);
});

test('history dates reload once when an expanded history panel crosses a local date boundary', () => {
  const source = readWebviewSource();
  const context = vm.createContext({ Date, Number, String, Boolean });
  vm.runInContext(extractFunction(source, 'formatLocalDateKey', 'shouldReloadHistoryDates'), context);
  vm.runInContext(extractFunction(source, 'shouldReloadHistoryDates', 'refreshHistoryDatesAfterDateChange'), context);
  const formatLocalDateKey = vm.runInContext('formatLocalDateKey', context) as (timestampMs: number) => string;
  const shouldReload = vm.runInContext('shouldReloadHistoryDates', context) as (
    expanded: boolean,
    previousDate: string,
    currentDate: string
  ) => boolean;

  const localMidnight = new Date(2026, 7, 14, 0, 5, 0).getTime();
  assert.equal(formatLocalDateKey(localMidnight), '2026-08-14');
  assert.equal(shouldReload(false, '2026-08-13', '2026-08-14'), false);
  assert.equal(shouldReload(true, '2026-08-14', '2026-08-14'), false);
  assert.equal(shouldReload(true, '2026-08-13', '2026-08-14'), true);
  assert.equal(shouldReload(true, '', '2026-08-14'), false);
  assert.doesNotMatch(extractFunction(source, 'formatLocalDateKey', 'shouldReloadHistoryDates'), /toISOString/);
});

test('history date requests restore the history trend to expanded state before loading', () => {
  const source = readWebviewSource();
  let persistCount = 0;
  let toggleArgs: { expanded: boolean; label: string } | undefined;
  const context = vm.createContext({
    historyTrendExpanded: false,
    historyTrendToggle: {},
    updateAggregateTrendToggle: (_toggle: unknown, expanded: boolean, label: string) => {
      toggleArgs = { expanded, label };
    },
    persistUiState: () => {
      persistCount += 1;
    }
  });
  vm.runInContext(extractFunction(source, 'ensureHistoryTrendExpanded', 'formatLocalDateKey'), context);

  const ensureHistoryTrendExpanded = vm.runInContext('ensureHistoryTrendExpanded', context) as () => void;
  ensureHistoryTrendExpanded();

  assert.equal(vm.runInContext('historyTrendExpanded', context), true);
  assert.deepEqual(toggleArgs, { expanded: true, label: '历史走势' });
  assert.equal(persistCount, 1);
});

test('history query results are normalized before rendering', () => {
  const source = readWebviewSource();
  const context = vm.createContext({ Map, Array, Number, String });
  vm.runInContext(extractFunction(source, 'normalizeHistoryQueryResult', 'buildHistoryTrend'), context);

  const normalize = vm.runInContext('normalizeHistoryQueryResult', context) as (
    value: unknown,
    fallbackDate: string
  ) => {
    date: string;
    startMs: number;
    endMs: number;
    rooms: Array<{ roomId: string; anchorName: string; points: Array<[number, number | null]> }>;
  };
  const result = normalize({
    date: '2026-08-16',
    startMs: 100,
    endMs: 'invalid',
    rooms: [
      null,
      {
        roomId: 123,
        anchorName: '  主播  ',
        points: [[300, 30], [100, 10], [200, null], [100, null], ['invalid', 8], [400, '8']]
      },
      { roomId: '', points: [[500, 50]] }
    ]
  }, 'fallback');

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    date: '2026-08-16',
    startMs: 100,
    endMs: 100,
    rooms: [{
      roomId: '123',
      anchorName: '主播',
      points: [[100, null], [200, null], [300, 30]]
    }]
  });
});

test('trend scale handles large historical datasets without spreading arguments', () => {
  const source = readWebviewSource();
  const context = vm.createContext({ Math, Number });
  vm.runInContext(extractFunction(source, 'getScaleForPoints', 'createSvgElement'), context);
  const getScale = vm.runInContext('getScaleForPoints', context) as (
    points: Array<[number, number | null]>
  ) => { min: number; max: number } | undefined;
  const points = Array.from({ length: 100_000 }, (_, index) => [index, index % 100] as [number, number]);

  const scale = getScale(points);
  assert.ok(scale);
  assert.equal(scale.min, 0);
  assert.equal(scale.max, 99);
  assert.doesNotMatch(extractFunction(source, 'getScaleForPoints', 'createSvgElement'), /Math\.(min|max)\(\.\.\.values\)/);
});

test('overview and history charts persist independently adjustable heights', () => {
  const source = readWebviewSource();
  const css = fs.readFileSync(path.resolve(__dirname, '../../media/webview.css'), 'utf8');
  const context = vm.createContext({
    Number,
    Math,
    AGGREGATE_CHART_DEFAULT_HEIGHT: 240,
    AGGREGATE_CHART_MIN_HEIGHT: 160,
    AGGREGATE_CHART_MAX_HEIGHT: 640
  });
  vm.runInContext(extractFunction(source, 'clampAggregateChartHeight', 'clampHistoryMinute'), context);
  const clampHeight = vm.runInContext('clampAggregateChartHeight', context) as (value: number) => number;

  assert.equal(clampHeight(Number.NaN), 240);
  assert.equal(clampHeight(100), 160);
  assert.equal(clampHeight(800), 640);
  assert.match(source, /overviewTrendHeight:\s*clampAggregateChartHeight/);
  assert.match(source, /historyTrendHeight:\s*clampAggregateChartHeight/);
  assert.match(source, /buildAggregateChartHeightControl\('overview'\)/);
  assert.match(source, /buildAggregateChartHeightControl\('history'\)/);
  assert.match(source, /chart\.style\.height = `\$\{chartHeight \+ 2\}px`/);
  assert.match(source, /placeholder\.style\.height = `\$\{clampAggregateChartHeight\(height\) \+ 2\}px`/);
  assert.match(css, /\.overview-chart svg\s*\{[^}]*height:\s*100%/s);
});

test('aggregate chart axes add adaptive readable ticks for width and height', () => {
  const source = readWebviewSource();
  const context = vm.createContext({ Number, Math, Set, Array });
  vm.runInContext(extractFunction(source, 'getAggregateChartScale', 'svgText'), context);
  const getScale = vm.runInContext('getAggregateChartScale', context) as (
    scale: { min: number; max: number }
  ) => { min: number; max: number };
  const numberTicks = vm.runInContext('buildAdaptiveNumberTicks', context) as (
    scale: { min: number; max: number },
    plotHeight: number
  ) => number[];
  const timeTicks = vm.runInContext('buildAdaptiveTimeTicks', context) as (
    trendWindow: { start: number; end: number },
    plotWidth: number
  ) => number[];
  const start = new Date(2026, 7, 17, 22, 53).getTime();
  const end = new Date(2026, 7, 17, 23, 30).getTime();

  assert.deepEqual(JSON.parse(JSON.stringify(getScale({ min: 320, max: 1080 }))), { min: 0, max: 1080 });
  assert.ok(numberTicks({ min: 0, max: 1080 }, 500).length > numberTicks({ min: 0, max: 1080 }, 110).length);
  assert.ok(timeTicks({ start, end }, 1000).length > timeTicks({ start, end }, 320).length);
  assert.equal(numberTicks({ min: 0, max: 1080 }, 190).includes(500), true);
  assert.equal(timeTicks({ start, end }, 1000).some((timestamp) => new Date(timestamp).getMinutes() % 5 === 0), true);
  assert.match(extractFunction(source, 'appendTrendAxis', 'getAggregateChartScale'), /buildAdaptiveNumberTicks/);
  assert.match(extractFunction(source, 'appendTrendAxis', 'getAggregateChartScale'), /buildAdaptiveTimeTicks/);
  assert.doesNotMatch(extractFunction(source, 'buildOverviewSvg', 'overviewLegend'), /\[0, 0\.25, 0\.5, 0\.75, 1\]/);
});

test('overview and history trend controls use the same responsive vertical layout', () => {
  const source = readWebviewSource();
  const css = fs.readFileSync(path.resolve(__dirname, '../../media/webview.css'), 'utf8');
  const overviewSource = extractFunction(source, 'buildOverviewTrend', 'renderHistoryTrend');
  const historySource = extractFunction(source, 'buildHistoryTrend', 'buildHistoryCalendar');

  assert.match(overviewSource, /buildTrendFieldHeading\('筛选范围'\)/);
  assert.match(overviewSource, /buildTrendFieldHeading\('时间范围', rangeLabel\)/);
  assert.match(historySource, /buildTrendFieldHeading\('筛选范围'\)/);
  assert.match(css, /\.overview-trend-header,\s*\.history-trend-header\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(css, /\.overview-trend-panel\s*\{[^}]*width:\s*100%[^}]*min-width:\s*360px/s);
  assert.match(css, /\.overview-legend\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
});

test('group drag target calculation handles long-distance reordering', () => {
  const source = readWebviewSource();
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, 'getGroupDropTargetIndex', 'updateGroupControls'), context);

  const groups = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const getTarget = (context as { getGroupDropTargetIndex: Function }).getGroupDropTargetIndex;
  assert.equal(getTarget(groups, 'a', 2, true), 2);
  assert.equal(getTarget(groups, 'c', 0, false), 0);
  assert.equal(getTarget(groups, 'a', 1, false), 0);
  assert.equal(getTarget(groups, 'missing', 1, true), -1);
});

test('aggregate trend panels keep permanent titlebars and collapse only their content', () => {
  const providerSource = readWebviewProviderSource();
  const webviewSource = readWebviewSource();
  const css = fs.readFileSync(path.resolve(__dirname, '../../media/webview.css'), 'utf8');
  const overviewRenderSource = extractFunction(webviewSource, 'renderOverviewTrend', 'buildOverviewTrend');
  const historyRenderSource = extractFunction(webviewSource, 'renderHistoryTrend', 'buildHistoryTrend');

  assert.doesNotMatch(providerSource, /聚合走势/);
  assert.match(providerSource, /id="overview-trend-toggle"[\s\S]*id="overview-trend-content"/);
  assert.match(providerSource, /id="history-trend-toggle"[\s\S]*id="history-trend-content"/);
  assert.doesNotMatch(providerSource, /id="overview-trend" class="overview-trend hidden"/);
  assert.doesNotMatch(providerSource, /id="history-trend" class="overview-trend hidden"/);
  assert.match(overviewRenderSource, /overviewTrendContent\.classList\.toggle\('hidden', !overviewTrendExpanded\)/);
  assert.match(historyRenderSource, /historyTrendContent\.classList\.toggle\('hidden', !historyTrendExpanded\)/);
  assert.doesNotMatch(overviewRenderSource, /overviewTrend\.classList\.toggle\('hidden'/);
  assert.doesNotMatch(historyRenderSource, /historyTrend\.classList\.toggle\('hidden'/);
  assert.match(css, /\.aggregate-panel-titlebar\s*\{[\s\S]*grid-template-columns:\s*28px/);
});

test('room list operations share one subpanel and advanced controls stay inside it', () => {
  const providerSource = readWebviewProviderSource();
  const css = fs.readFileSync(path.resolve(__dirname, '../../media/webview.css'), 'utf8');
  const panelStart = providerSource.indexOf('<section id="room-list-panel"');
  const panelEnd = providerSource.indexOf('<section id="overview-trend"', panelStart);
  const panelSource = providerSource.slice(panelStart, panelEnd);
  const toolbarStart = providerSource.indexOf('<section class="toolbar"');
  const toolbarEnd = providerSource.indexOf('</section>', toolbarStart);
  const toolbarSource = providerSource.slice(toolbarStart, toolbarEnd);

  assert.notEqual(panelStart, -1);
  assert.notEqual(panelEnd, -1);
  assert.ok(panelSource.indexOf('class="list-controls"') < panelSource.indexOf('id="control-panel"'));
  assert.ok(panelSource.indexOf('id="control-panel"') < panelSource.indexOf('id="summary"'));
  assert.ok(panelSource.indexOf('id="summary"') < panelSource.indexOf('id="rooms"'));
  assert.match(panelSource, /id="create-group-button"[\s\S]*id="control-panel-toggle"/);
  assert.match(panelSource, /id="control-panel-toggle"[\s\S]*aria-controls="control-panel"/);
  assert.ok(panelSource.indexOf('>刷新</div>') < panelSource.indexOf('>分组</div>'));
  assert.match(panelSource, /id="base-info-interval-input"/);
  assert.match(panelSource, /id="online-interval-input"/);
  assert.match(panelSource, /id="fans-interval-input"/);
  assert.match(panelSource, /id="guard-interval-input"/);
  assert.doesNotMatch(toolbarSource, /control-panel-toggle/);
  assert.doesNotMatch(toolbarSource, /create-group-button/);
  assert.match(css, /\.toolbar\s*\{[\s\S]*repeat\(2, 28px\)/);
  assert.match(css, /\.room-list-panel\s*\{[\s\S]*border:/);
  assert.match(css, /\.room-list-panel\s*\{[\s\S]*order:\s*3/);
  assert.match(css, /\.overview-trend\s*\{[\s\S]*order:\s*1/);
  assert.match(css, /\.display-controls\s*\{[\s\S]*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.status-filter\s*\{[\s\S]*grid-column:\s*span 3/);
  assert.match(css, /\.status-filter button\s*\{[\s\S]*height:\s*28px/);
  assert.match(css, /\.data-refresh-field input\s*\{[\s\S]*width:\s*64px/);
  assert.match(css, /\.trend-toggle\s*\{[\s\S]*background:\s*transparent/);
  assert.match(css, /\.trend-toggle\.active[\s\S]*background:\s*var\(--vscode-button-background\)/);
  assert.match(css, /\.overview-mode-button\s*\{[\s\S]*background:\s*transparent/);
  assert.match(css, /\.overview-mode-button\.active[\s\S]*background:\s*var\(--vscode-button-background\)/);
  assert.match(css, /\.overview-chart\s*\{[\s\S]*height:\s*242px/);
  assert.match(css, /\.overview-placeholder\s*\{[\s\S]*height:\s*242px/);
  assert.match(css, /\.trend-chart\s*\{[\s\S]*height:\s*91px/);
  assert.match(css, /\.trend-placeholder\s*\{[\s\S]*height:\s*86px/);
  assert.match(css, /\.overview-trend\.collapsed \.aggregate-panel-titlebar\s*\{[\s\S]*border-bottom-color:\s*transparent/);
  assert.match(css, /\.room-list-panel-content\s*\{[\s\S]*padding:/);
});

test('cached metric state is visually marked and includes the last success time in its tooltip', () => {
  const source = readWebviewSource();
  const css = fs.readFileSync(path.resolve(__dirname, '../../media/webview.css'), 'utf8');
  const helperSource = extractFunction(source, 'applyCachedMetricState', 'durationValue');

  assert.match(source, /room\.fansCountStale/);
  assert.match(source, /room\.guardFleetStale/);
  assert.match(source, /room\.onlineStale/);
  assert.match(helperSource, /metric-stale/);
  assert.match(helperSource, /本轮获取失败/);
  assert.match(helperSource, /lastSuccessAt/);
  assert.match(css, /\.metric-stale\s*\{[\s\S]*editorWarning-foreground/);
});

test('all three subpanels share a titlebar and the room list has an independent persisted toggle', () => {
  const providerSource = readWebviewProviderSource();
  const webviewSource = readWebviewSource();
  const css = fs.readFileSync(path.resolve(__dirname, '../../media/webview.css'), 'utf8');
  const roomListRenderSource = extractFunction(webviewSource, 'render', 'rerenderLatestSnapshot');

  assert.match(providerSource, /id="room-list-toggle"[\s\S]*aria-controls="room-list-content"/);
  assert.match(providerSource, /id="room-list-content" class="subpanel-content room-list-panel-content"/);
  assert.match(providerSource, /class="subpanel-titlebar room-list-panel-header"/);
  assert.match(providerSource, /class="subpanel-titlebar aggregate-panel-titlebar"/g);
  assert.match(webviewSource, /const roomListToggle = document\.getElementById\('room-list-toggle'\)/);
  assert.match(webviewSource, /let roomListExpanded = persistedState\.roomListExpanded/);
  assert.match(webviewSource, /roomListExpanded,\s*\n\s*controlPanelExpanded/);
  assert.match(webviewSource, /roomListExpanded: safeState\.roomListExpanded !== false/);
  assert.match(roomListRenderSource, /updateSubpanelToggle\(roomListPanel, roomListContent, roomListToggle, roomListExpanded/);
  assert.match(webviewSource, /function updateSubpanelToggle\(panel, content, toggle, expanded, label\)/);
  assert.doesNotMatch(webviewSource, /overviewTrendToggle\.classList\.toggle\('active'/);
  assert.doesNotMatch(webviewSource, /historyTrendToggle\.classList\.toggle\('active'/);
  assert.doesNotMatch(webviewSource, /controlPanelToggle\.classList\.toggle\('active'/);
  assert.doesNotMatch(css, /\.aggregate-panel-toggle\.active/);
  assert.doesNotMatch(css, /\.control-panel-toggle\.active/);
  assert.match(css, /\.subpanel\s*\{[\s\S]*border:/);
  assert.match(css, /\.subpanel-titlebar\s*\{[\s\S]*grid-template-columns:\s*28px minmax\(0, 1fr\) max-content/);
  assert.match(css, /\.subpanel-toggle,[\s\S]*width:\s*28px[\s\S]*height:\s*28px/);
  assert.match(css, /\.subpanel\.collapsed \.subpanel-titlebar\s*\{[\s\S]*border-bottom-color:\s*transparent/);
});
