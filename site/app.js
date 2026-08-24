(() => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'bwatch.historySite.state.v1';
  const PALETTE = [
    '#3B82F6', '#22C55E', '#EAB308', '#EF4444', '#A855F7', '#F97316',
    '#06B6D4', '#EC4899', '#84CC16', '#14B8A6', '#8B5CF6', '#F43F5E',
    '#0EA5E9', '#D946EF', '#E879F9', '#10B981', '#F59E0B', '#6366F1',
    '#FB7185', '#2DD4BF', '#A3E635', '#38BDF8', '#C084FC', '#FB923C'
  ];

  const refs = Object.fromEntries([
    'exportStatus', 'themeToggle', 'dateInput', 'dateButtons', 'roomSelect', 'sessionSelect', 'clearSession', 'heightRange', 'heightLabel',
    'rangeStart', 'rangeEnd', 'rangeFill', 'rangeLabel', 'scopeFilters', 'notice', 'chartSummary',
    'chartFrame', 'chart', 'tooltip', 'chartEmpty', 'legend', 'legendCount', 'hideAll', 'showAll'
  ].map((id) => [id, document.getElementById(id)]));

  const state = {
    manifest: null,
    dateFiles: [],
    selectedDate: '',
    twoDays: false,
    startMinute: 0,
    endMinute: 1439,
    roomId: '',
    sessionId: '',
    filters: new Set(['all']),
    aggregates: new Set(),
    hidden: new Set(),
    theme: 'system',
    height: 480,
    series: [],
    loadingToken: 0
  };

  init();

  async function init() {
    bindEvents();
    restoreState();
    applyTheme();
    setLoading(true);
    try {
      const response = await fetch('./data/v1/manifest.json', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Manifest 请求失败（HTTP ${response.status}）`);
      }
      const manifest = await response.json();
      validateManifest(manifest);
      state.manifest = manifest;
      populateControls();
      renderExportStatus();
      if (manifest.dates.length === 0) {
        showNotice('当前还没有导出的历史数据。', false);
        setLoading(false);
        render();
        return;
      }
      await loadSelectedDates();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '历史数据加载失败。', true);
      refs.exportStatus.textContent = '数据不可用';
      setLoading(false);
      render();
    }
  }

  function bindEvents() {
    refs.themeToggle.addEventListener('click', () => {
      state.theme = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
      applyTheme();
      persistState();
    });
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (state.theme === 'system') applyTheme();
    });
    refs.dateInput.addEventListener('change', async () => {
      if (!state.manifest?.dates.some((item) => item.date === refs.dateInput.value)) {
        refs.dateInput.value = state.selectedDate;
        return;
      }
      state.selectedDate = refs.dateInput.value;
      state.twoDays = false;
      state.sessionId = '';
      refs.sessionSelect.value = '';
      resetRange();
      renderDateButtons();
      await loadSelectedDates();
    });
    refs.roomSelect.addEventListener('change', async () => {
      state.roomId = refs.roomSelect.value;
      state.sessionId = '';
      await populateSessions();
      persistState();
      render();
    });
    refs.sessionSelect.addEventListener('change', () => {
      locateSession();
    });
    refs.clearSession.addEventListener('click', clearSessionFilter);
    refs.heightRange.addEventListener('input', () => {
      state.height = clamp(Number(refs.heightRange.value) || 480, 160, 640);
      refs.heightLabel.textContent = `${state.height} px`;
      refs.chartFrame.style.setProperty('--chart-height', `${state.height}px`);
      renderChart();
    });
    refs.heightRange.addEventListener('change', () => {
      persistState();
    });
    refs.rangeStart.addEventListener('input', () => updateRange('start'));
    refs.rangeEnd.addEventListener('input', () => updateRange('end'));
    refs.hideAll.addEventListener('click', () => {
      state.series.forEach((series) => state.hidden.add(series.id));
      persistState();
      render();
    });
    refs.showAll.addEventListener('click', () => {
      state.hidden.clear();
      persistState();
      render();
    });
    refs.chart.addEventListener('pointermove', showTooltip);
    refs.chart.addEventListener('pointerleave', hideTooltip);
    window.addEventListener('resize', debounce(render, 80));
  }

  function validateManifest(value) {
    if (!value || typeof value !== 'object') {
      throw new Error('Manifest 内容损坏。');
    }
    if (value.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`不支持的数据版本：${String(value.schemaVersion)}。页面仅接受 schemaVersion 1。`);
    }
    if (!Array.isArray(value.rooms) || !Array.isArray(value.groups) || !Array.isArray(value.dates)) {
      throw new Error('Manifest 缺少房间、分组或日期索引。');
    }
    value.dates.sort((left, right) => left.date.localeCompare(right.date));
    value.rooms.sort((left, right) => left.order - right.order || compareRoomIds(left.roomId, right.roomId));
  }

  function populateControls() {
    const manifest = state.manifest;
    const availableDates = new Set(manifest.dates.map((item) => item.date));
    state.selectedDate = availableDates.has(state.selectedDate)
      ? state.selectedDate
      : manifest.dates.at(-1)?.date || '';
    if (state.twoDays && !availableDates.has(getNextDate(state.selectedDate))) {
      state.twoDays = false;
      state.endMinute = Math.min(state.endMinute, 1439);
    }

    refs.dateInput.value = state.selectedDate;
    refs.dateInput.min = manifest.dates[0]?.date || '';
    refs.dateInput.max = manifest.dates.at(-1)?.date || '';
    refs.roomSelect.replaceChildren(
      option('', '选择主播'),
      ...manifest.rooms.map((room) => option(room.roomId, `${room.anchorName} · ${room.roomId}${room.monitored ? '' : '（历史）'}`))
    );
    if (manifest.rooms.some((room) => room.roomId === state.roomId)) {
      refs.roomSelect.value = state.roomId;
    } else {
      state.roomId = '';
    }
    refs.heightRange.value = String(state.height);
    refs.heightLabel.textContent = `${state.height} px`;
    refs.chartFrame.style.setProperty('--chart-height', `${state.height}px`);
    renderDateButtons();
  }

  function getEffectiveTheme() {
    if (state.theme === 'light' || state.theme === 'dark') return state.theme;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const explicitTheme = state.theme === 'light' || state.theme === 'dark' ? state.theme : '';
    if (explicitTheme) {
      document.documentElement.dataset.theme = explicitTheme;
    } else {
      delete document.documentElement.dataset.theme;
    }
    const effectiveTheme = getEffectiveTheme();
    const icon = refs.themeToggle.querySelector('[aria-hidden="true"]');
    if (icon) icon.textContent = effectiveTheme === 'dark' ? '☀' : '☾';
    const label = effectiveTheme === 'dark' ? '切换至日间模式' : '切换至夜间模式';
    refs.themeToggle.title = label;
    refs.themeToggle.setAttribute('aria-label', label);
  }

  function renderExportStatus() {
    const manifest = state.manifest;
    if (!manifest.generatedAt) {
      refs.exportStatus.textContent = '尚未执行正式导出';
      return;
    }
    refs.exportStatus.textContent = `最后导出 ${formatDateTime(manifest.generatedAt, true)} · ${manifest.timeZone}`;
  }

  function getAvailableScopes() {
    return [
      { id: 'all', label: '全部' },
      { id: 'withData', label: '有数据' },
      ...state.manifest.groups.map((group) => ({ id: `group:${group.id}`, label: group.name }))
    ];
  }

  function renderScopeFilters(roomSeries = []) {
    const scopes = getAvailableScopes();
    const validIds = new Set(scopes.map((scope) => scope.id));
    state.filters = new Set(Array.from(state.filters).filter((scope) => validIds.has(scope)));
    state.aggregates = new Set(Array.from(state.aggregates).filter((scope) => validIds.has(scope)));
    const dataRoomIds = new Set(roomSeries.map((series) => series.roomId));
    const positiveRoomIds = new Set(roomSeries
      .filter((series) => series.points.some((point) => isFiniteNumber(point[1]) && point[1] > 0))
      .map((series) => series.roomId));
    refs.scopeFilters.replaceChildren(...scopes.map((scope) => {
      const control = document.createElement('div');
      control.className = 'scope-control';
      const roomIds = getScopeRoomIds(scope.id, dataRoomIds, positiveRoomIds);
      const liveCount = Array.from(roomIds).filter((roomId) =>
        state.manifest.rooms.find((room) => room.roomId === roomId)?.latestStatus === 'live'
      ).length;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scope-button';
      button.textContent = `${scope.label} ${liveCount}/${roomIds.size}`;
      button.title = `加入或移出“${scope.label}”范围`;
      button.dataset.scope = scope.id;
      button.setAttribute('aria-pressed', String(state.filters.has(scope.id)));
      button.addEventListener('click', () => {
        if (state.filters.has(scope.id)) {
          state.filters.delete(scope.id);
        } else {
          state.filters.add(scope.id);
        }
        persistState();
        render();
      });
      const aggregateButton = document.createElement('button');
      aggregateButton.type = 'button';
      aggregateButton.className = 'aggregate-scope-button';
      aggregateButton.textContent = 'Σ';
      aggregateButton.title = `${state.aggregates.has(scope.id) ? '移除' : '添加'}“${scope.label}”在线人数合计曲线`;
      aggregateButton.setAttribute('aria-label', aggregateButton.title);
      aggregateButton.setAttribute('aria-pressed', String(state.aggregates.has(scope.id)));
      aggregateButton.addEventListener('click', () => {
        if (state.aggregates.has(scope.id)) {
          state.aggregates.delete(scope.id);
          state.hidden.delete(`sum:${scope.id}`);
        } else {
          state.aggregates.add(scope.id);
        }
        persistState();
        render();
      });
      control.append(button, aggregateButton);
      return control;
    }));
  }

  function getSelectedDates() {
    return state.twoDays ? [state.selectedDate, getNextDate(state.selectedDate)] : [state.selectedDate];
  }

  function renderDateButtons() {
    if (!state.manifest) return;
    const selectedDates = new Set(getSelectedDates());
    refs.dateInput.value = state.selectedDate;
    refs.dateButtons.replaceChildren(...state.manifest.dates.map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'date-button';
      button.textContent = formatHistoryDateLabel(item.date);
      button.title = `${item.roomIds.length} 个直播间，${formatNumber(item.pointCount)} 个采样点`;
      button.setAttribute('aria-pressed', String(selectedDates.has(item.date)));
      button.addEventListener('click', () => selectHistoryDate(item.date));
      return button;
    }));
  }

  async function selectHistoryDate(date) {
    const selectedDates = getSelectedDates();
    state.sessionId = '';
    refs.sessionSelect.value = '';
    if (selectedDates.length === 2 && selectedDates.includes(date)) {
      state.selectedDate = selectedDates.find((item) => item !== date) || date;
      state.twoDays = false;
      state.endMinute = Math.min(state.endMinute, 1439);
    } else if (selectedDates.length === 1 && date !== state.selectedDate && areAdjacentDates(state.selectedDate, date)) {
      state.selectedDate = date < state.selectedDate ? date : state.selectedDate;
      state.twoDays = true;
      state.endMinute = 2879;
    } else if (!selectedDates.includes(date)) {
      state.selectedDate = date;
      state.twoDays = false;
      state.endMinute = Math.min(state.endMinute, 1439);
    } else {
      return;
    }
    refs.dateInput.value = state.selectedDate;
    normalizeRange();
    renderDateButtons();
    await loadSelectedDates();
  }

  async function loadSelectedDates() {
    if (!state.manifest || !state.selectedDate) {
      return;
    }
    const token = ++state.loadingToken;
    setLoading(true);
    hideNotice();
    const dates = getSelectedDates();
    try {
      const metadata = dates.map((date) => state.manifest.dates.find((item) => item.date === date));
      if (metadata.some((item) => !item)) {
        throw new Error('选择的日期不在 Manifest 索引中。');
      }
      const files = await Promise.all(metadata.map(async (item) => {
        const join = item.file.includes('?') ? '&' : '?';
        const response = await fetch(`./data/v1/${item.file}${join}v=${encodeURIComponent(state.manifest.generatedAt)}`, { cache: 'default' });
        if (!response.ok) {
          throw new Error(`${item.date} 数据文件请求失败（HTTP ${response.status}）`);
        }
        const value = await response.json();
        if (value.schemaVersion !== SCHEMA_VERSION || value.date !== item.date || !Array.isArray(value.rooms)) {
          throw new Error(`${item.date} 数据文件结构不兼容。`);
        }
        return value;
      }));
      if (token !== state.loadingToken) {
        return;
      }
      state.dateFiles = files;
      normalizeRange();
      await populateSessions();
      setLoading(false);
      persistState();
      render();
    } catch (error) {
      if (token !== state.loadingToken) {
        return;
      }
      state.dateFiles = [];
      setLoading(false);
      showNotice(error instanceof Error ? error.message : '日期数据加载失败。', true);
      render();
    }
  }

  async function populateSessions() {
    refs.sessionSelect.replaceChildren(option('', state.roomId ? '正在读取直播场次' : '先选择主播'));
    refs.sessionSelect.disabled = !state.roomId;
    refs.clearSession.hidden = !state.roomId;
    if (!state.roomId) {
      refs.sessionSelect.dataset.sessions = '[]';
      return;
    }
    const room = state.manifest.rooms.find((item) => item.roomId === state.roomId);
    if (!room) {
      return;
    }
    try {
      const response = await fetch(`./data/v1/${room.sessionFile}?v=${encodeURIComponent(state.manifest.generatedAt)}`);
      if (!response.ok) {
        throw new Error(`场次文件请求失败（HTTP ${response.status}）`);
      }
      const value = await response.json();
      if (value.schemaVersion !== SCHEMA_VERSION || value.roomId !== room.roomId || !Array.isArray(value.sessions)) {
        throw new Error('场次文件结构不兼容。');
      }
      refs.sessionSelect.replaceChildren(
        option('', value.sessions.length > 0 ? '选择直播场次' : '暂无可识别的直播场次'),
        ...value.sessions.map((session) => option(
          sessionKey(session),
          `${formatDateTime(session.startMs, true)} - ${formatDateTime(session.endMs, true)} · ${formatSessionDuration(session.durationMs)} · 峰值 ${formatNumber(session.peakOnline)}`
        ))
      );
      refs.sessionSelect.disabled = false;
      refs.sessionSelect.dataset.sessions = JSON.stringify(value.sessions);
      if (value.sessions.some((session) => sessionKey(session) === state.sessionId)) {
        refs.sessionSelect.value = state.sessionId;
      } else {
        state.sessionId = '';
      }
    } catch (error) {
      refs.sessionSelect.replaceChildren(option('', '场次读取失败'));
      refs.sessionSelect.disabled = true;
      showNotice(error instanceof Error ? error.message : '场次数据加载失败。', true);
    }
  }

  async function locateSession() {
    state.sessionId = refs.sessionSelect.value;
    if (!state.sessionId) {
      persistState();
      render();
      return;
    }
    const sessions = safeJson(refs.sessionSelect.dataset.sessions, []);
    const session = sessions.find((item) => sessionKey(item) === state.sessionId);
    if (!session) {
      return;
    }
    const expandedStartMs = session.startMs - 5 * 60_000;
    const expandedEndMs = session.endMs + 5 * 60_000;
    const startDate = findManifestDate(expandedStartMs) || findManifestDate(session.startMs);
    const endDate = findManifestDate(expandedEndMs) || findManifestDate(session.endMs);
    if (!startDate) {
      showNotice('这个场次所在日期尚未导出。', false);
      return;
    }
    state.selectedDate = startDate.date;
    state.twoDays = Boolean(endDate && endDate.date !== startDate.date && getNextDate(startDate.date) === endDate.date);
    refs.dateInput.value = state.selectedDate;
    renderDateButtons();
    const baseMs = startDate.startMs;
    const maxMinute = state.twoDays ? 2879 : 1439;
    state.startMinute = clamp(Math.floor((expandedStartMs - baseMs) / 60_000), 0, maxMinute);
    state.endMinute = clamp(Math.ceil((expandedEndMs - baseMs) / 60_000), 0, maxMinute);
    applySessionControls();
    await loadSelectedDates();
  }

  function clearSessionFilter() {
    state.roomId = '';
    state.sessionId = '';
    refs.roomSelect.value = '';
    refs.sessionSelect.replaceChildren(option('', '先选择主播'));
    refs.sessionSelect.disabled = true;
    refs.sessionSelect.dataset.sessions = '[]';
    refs.clearSession.hidden = true;
    persistState();
    render();
  }

  function applySessionControls() {
    if (!state.roomId || !state.sessionId || !state.manifest) return;
    state.filters = new Set(['all']);
    const hidden = new Set();
    for (const room of state.manifest.rooms) {
      if (room.roomId !== state.roomId) {
        hidden.add('room:' + room.roomId);
      }
    }
    for (const scope of getAvailableScopes()) {
      hidden.add('sum:' + scope.id);
    }
    state.hidden = hidden;
  }

  function updateRange(source) {
    const start = Number(refs.rangeStart.value);
    const end = Number(refs.rangeEnd.value);
    if (source === 'start') {
      state.startMinute = Math.min(start, end - 1);
      state.endMinute = end;
    } else {
      state.startMinute = start;
      state.endMinute = Math.max(end, start + 1);
    }
    refs.rangeStart.value = String(state.startMinute);
    refs.rangeEnd.value = String(state.endMinute);
    updateRangePresentation();
    persistState();
    render();
  }

  function resetRange() {
    state.startMinute = 0;
    state.endMinute = state.twoDays ? 2879 : 1439;
  }

  function normalizeRange() {
    const max = state.twoDays ? 2879 : 1439;
    state.startMinute = clamp(state.startMinute, 0, max - 1);
    state.endMinute = clamp(state.endMinute, state.startMinute + 1, max);
    refs.rangeStart.max = String(max);
    refs.rangeEnd.max = String(max);
    refs.rangeStart.value = String(state.startMinute);
    refs.rangeEnd.value = String(state.endMinute);
    updateRangePresentation();
  }

  function updateRangePresentation() {
    const max = Number(refs.rangeEnd.max) || 1439;
    const startPercent = state.startMinute / max * 100;
    const endPercent = state.endMinute / max * 100;
    refs.rangeFill.style.left = `${startPercent}%`;
    refs.rangeFill.style.right = `${100 - endPercent}%`;
    const base = state.dateFiles[0]?.startMs;
    refs.rangeLabel.value = base
      ? `${formatRangeMinute(state.startMinute)} - ${formatRangeMinute(state.endMinute)}`
      : '00:00 - 23:59';
  }

  function render() {
    const allRoomSeries = buildRoomSeries();
    renderScopeFilters(allRoomSeries);
    const visibleRoomSeries = filterRoomSeries(allRoomSeries);
    const aggregateSeries = buildAggregateSeries(allRoomSeries);
    state.series = [...aggregateSeries, ...visibleRoomSeries];
    renderLegend();
    renderChart();
    const visibleCount = state.series.filter((series) => !state.hidden.has(series.id)).length;
    const points = visibleRoomSeries.reduce((total, series) => total + series.points.length, 0);
    refs.chartSummary.textContent = `${state.dateFiles.length || 0} 日 · ${visibleRoomSeries.length} 位主播 · ${formatNumber(points)} 个采样 · ${visibleCount} 条可见曲线`;
  }

  function buildRoomSeries() {
    if (!state.manifest || state.dateFiles.length === 0) {
      return [];
    }
    const startMs = state.dateFiles[0].startMs + state.startMinute * 60_000;
    const endMs = state.dateFiles[0].startMs + state.endMinute * 60_000 + 59_999;
    const roomPoints = new Map();
    for (const file of state.dateFiles) {
      for (const room of file.rooms) {
        const points = roomPoints.get(room.roomId) || [];
        for (const point of room.points) {
          const timestamp = file.startMs + point[0];
          if (timestamp >= startMs && timestamp <= endMs && (point[1] === null || isFiniteNumber(point[1]))) {
            points.push([timestamp, point[1]]);
          }
        }
        roomPoints.set(room.roomId, points);
      }
    }
    return state.manifest.rooms
      .map((room, index) => ({
        id: `room:${room.roomId}`,
        roomId: room.roomId,
        label: room.anchorName,
        meta: room.monitored ? room.roomId : `${room.roomId} · 历史`,
        color: colorForRoom(room.roomId, index),
        points: (roomPoints.get(room.roomId) || []).sort((left, right) => left[0] - right[0]),
        aggregate: false
      }))
      .filter((series) => series.points.length > 0);
  }

  function filterRoomSeries(roomSeries) {
    const dataRoomIds = new Set(roomSeries.map((series) => series.roomId));
    const positiveRoomIds = new Set(
      roomSeries.filter((series) => series.points.some((point) => isFiniteNumber(point[1]) && point[1] > 0))
        .map((series) => series.roomId)
    );
    const allowedRoomIds = new Set();
    for (const scope of state.filters) {
      getScopeRoomIds(scope, dataRoomIds, positiveRoomIds).forEach((roomId) => allowedRoomIds.add(roomId));
    }
    return roomSeries.filter((series) => allowedRoomIds.has(series.roomId));
  }

  function buildAggregateSeries(roomSeries) {
    if (state.aggregates.size === 0) {
      return [];
    }
    const dataRoomIds = new Set(roomSeries.map((series) => series.roomId));
    const positiveRoomIds = new Set(
      roomSeries.filter((series) => series.points.some((point) => isFiniteNumber(point[1]) && point[1] > 0))
        .map((series) => series.roomId)
    );
    return Array.from(state.aggregates).map((scope) => {
      const roomIds = getScopeRoomIds(scope, dataRoomIds, positiveRoomIds);
      const members = roomSeries.filter((series) => roomIds.has(series.roomId));
      if (members.length === 0) {
        return null;
      }
      return {
        id: `sum:${scope}`,
        label: `Σ ${getScopeLabel(scope)}`,
        meta: `${members.length} 位`,
        color: colorForTrend(state.manifest.rooms.length + getScopeColorIndex(scope)),
        points: sumSeriesPoints(members),
        aggregate: true
      };
    }).filter(Boolean);
  }

  function getScopeRoomIds(scope, dataRoomIds, positiveRoomIds) {
    if (scope === 'all') {
      return new Set(dataRoomIds);
    }
    if (scope === 'withData') {
      return new Set(positiveRoomIds);
    }
    if (scope.startsWith('group:')) {
      const group = state.manifest.groups.find((item) => item.id === scope.slice(6));
      return new Set((group?.rooms || []).filter((roomId) => dataRoomIds.has(roomId)));
    }
    return new Set();
  }

  function getScopeColorIndex(scope) {
    if (scope === 'all') return 0;
    if (scope === 'withData') return 2;
    const groupIndex = state.manifest.groups.findIndex((group) => group.id === scope.slice(6));
    return groupIndex >= 0 ? groupIndex + 3 : 0;
  }

  function getScopeLabel(scope) {
    if (scope === 'all') return '全部合计';
    if (scope === 'withData') return '有数据合计';
    const group = state.manifest.groups.find((item) => item.id === scope.slice(6));
    return `${group?.name || '分组'}合计`;
  }

  function sumSeriesPoints(seriesList) {
    const pointMaps = seriesList.map((series) => new Map(series.points));
    const timestamps = new Set(pointMaps.flatMap((points) => Array.from(points.keys())));
    return Array.from(timestamps).sort((a, b) => a - b).map((timestamp) => {
      const values = pointMaps.map((points) => points.get(timestamp));
      if (values.some((value) => value === null)) {
        return [timestamp, null];
      }
      const numbers = values.filter(isFiniteNumber);
      return [timestamp, numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null];
    });
  }

  function findLatestValidPoint(points) {
    for (let index = points.length - 1; index >= 0; index -= 1) {
      if (isFiniteNumber(points[index][1])) return points[index];
    }
    return null;
  }

  function renderLegend() {
    const sortedSeries = state.series
      .map((series, index) => ({ series, index, latestPoint: findLatestValidPoint(series.points) }))
      .sort((left, right) => {
        const leftOnline = left.latestPoint?.[1];
        const rightOnline = right.latestPoint?.[1];
        if (!isFiniteNumber(leftOnline)) return isFiniteNumber(rightOnline) ? 1 : left.index - right.index;
        if (!isFiniteNumber(rightOnline)) return -1;
        return rightOnline - leftOnline || left.index - right.index;
      });
    refs.legendCount.textContent = `${state.series.length} 条曲线`;
    refs.legend.replaceChildren(...sortedSeries.map(({ series, latestPoint }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `legend-item${series.aggregate ? ' aggregate' : ''}${state.hidden.has(series.id) ? ' off' : ''}`;
      button.title = `${state.hidden.has(series.id) ? '显示' : '隐藏'} ${series.label}`;
      button.setAttribute('aria-pressed', String(!state.hidden.has(series.id)));
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.style.background = series.color;
      const name = document.createElement('span');
      name.className = 'legend-name';
      name.textContent = series.label;
      const meta = document.createElement('span');
      meta.className = 'legend-meta';
      meta.textContent = latestPoint ? formatNumber(latestPoint[1]) : '--';
      button.append(swatch, name, meta);
      button.addEventListener('click', () => {
        if (state.hidden.has(series.id)) state.hidden.delete(series.id);
        else state.hidden.add(series.id);
        persistState();
        render();
      });
      return button;
    }));
  }

  function renderChart() {
    const svg = refs.chart;
    const width = Math.max(320, refs.chartFrame.clientWidth || 900);
    const height = Math.max(260, refs.chartFrame.clientHeight || state.height);
    const fixedMargin = { top: 24, right: 24, bottom: 42 };
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.replaceChildren();
    const visible = state.series.filter((series) => !state.hidden.has(series.id));
    const plottableSeries = visible.filter((series) => series.points.some((point) => isFiniteNumber(point[1])));
    const numericPoints = plottableSeries.flatMap((series) => series.points.filter((point) => isFiniteNumber(point[1])));
    refs.chartEmpty.hidden = numericPoints.length > 0;
    if (numericPoints.length === 0 || state.dateFiles.length === 0) {
      svg.dataset.chart = '';
      hideTooltip();
      return;
    }

    const startMs = state.dateFiles[0].startMs + state.startMinute * 60_000;
    const endMs = state.dateFiles[0].startMs + state.endMinute * 60_000 + 59_999;
    const plotHeight = height - fixedMargin.top - fixedMargin.bottom;
    const yScale = buildYAxisScale(numericPoints.map((point) => point[1]), plotHeight);
    const longestYLabel = yScale.ticks.reduce((length, value) => Math.max(length, formatNumber(value).length), 1);
    const margin = {
      ...fixedMargin,
      left: Math.min(Math.max(62, longestYLabel * 7 + 18), Math.max(62, width * 0.3))
    };
    const plot = { x: margin.left, y: margin.top, width: width - margin.left - margin.right, height: plotHeight };
    const scaleX = (value) => plot.x + (value - startMs) / Math.max(1, endMs - startMs) * plot.width;
    const scaleY = (value) => plot.y + plot.height - (value - yScale.min) / Math.max(1, yScale.max - yScale.min) * plot.height;

    for (const value of yScale.ticks) {
      const y = scaleY(value);
      svg.append(svgLine(plot.x, y, plot.x + plot.width, y, 'grid-line'));
      svg.append(svgText(plot.x - 10, y + 4, formatNumber(value), 'axis-label', 'end'));
    }
    const xTickCount = width < 620 ? 4 : 7;
    for (let index = 0; index <= xTickCount; index += 1) {
      const timestamp = startMs + (endMs - startMs) * index / xTickCount;
      const x = scaleX(timestamp);
      svg.append(svgLine(x, plot.y, x, plot.y + plot.height, 'grid-line'));
      svg.append(svgText(x, plot.y + plot.height + 24, formatAxisTime(timestamp), 'axis-label', 'middle'));
    }
    svg.append(svgLine(plot.x, plot.y + plot.height, plot.x + plot.width, plot.y + plot.height, 'axis-line'));
    svg.append(svgLine(plot.x, plot.y, plot.x, plot.y + plot.height, 'axis-line'));

    if (state.dateFiles.length === 2) {
      const midnight = state.dateFiles[1].startMs;
      if (midnight >= startMs && midnight <= endMs) {
        const x = scaleX(midnight);
        svg.append(svgLine(x, plot.y, x, plot.y + plot.height, 'midnight-line'));
        svg.append(svgText(x + 5, plot.y + 12, state.dateFiles[1].date, 'midnight-label', 'start'));
      }
    }

    if (plottableSeries.length === 1) {
      const peakValue = plottableSeries[0].points.reduce((maximum, point) => isFiniteNumber(point[1]) ? Math.max(maximum, point[1]) : maximum, 0);
      const peakY = scaleY(peakValue);
      svg.append(svgLine(plot.x, peakY, plot.x + plot.width, peakY, 'peak-line'));
      svg.append(svgText(plot.x + plot.width - 4, peakY - 7, `峰值 ${formatNumber(peakValue)}`, 'peak-label', 'end'));
    }

    for (const series of plottableSeries) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', buildPath(series.points, scaleX, scaleY));
      path.setAttribute('stroke', series.color);
      path.setAttribute('class', `series-path${series.aggregate ? ' aggregate' : ''}`);
      path.dataset.seriesId = series.id;
      svg.append(path);
    }

    const hoverLine = svgLine(plot.x, plot.y, plot.x, plot.y + plot.height, 'hover-line');
    hoverLine.hidden = true;
    hoverLine.id = 'hoverLine';
    svg.append(hoverLine);
    svg.dataset.chart = JSON.stringify({ startMs, endMs, x: plot.x, width: plot.width, top: plot.y, bottom: plot.y + plot.height });
  }

  function buildPath(points, scaleX, scaleY) {
    let path = '';
    let drawing = false;
    for (const [timestamp, value] of points) {
      if (!isFiniteNumber(value)) {
        drawing = false;
        continue;
      }
      path += `${drawing ? 'L' : 'M'}${scaleX(timestamp).toFixed(2)},${scaleY(value).toFixed(2)}`;
      drawing = true;
    }
    return path;
  }

  function showTooltip(event) {
    const chartData = safeJson(refs.chart.dataset.chart, null);
    if (!chartData) return;
    const rect = refs.chart.getBoundingClientRect();
    const svgX = (event.clientX - rect.left) / rect.width * refs.chart.viewBox.baseVal.width;
    if (svgX < chartData.x || svgX > chartData.x + chartData.width) {
      hideTooltip();
      return;
    }
    const ratio = (svgX - chartData.x) / chartData.width;
    const timestamp = chartData.startMs + (chartData.endMs - chartData.startMs) * ratio;
    const rows = state.series
      .filter((series) => !state.hidden.has(series.id))
      .map((series) => ({ series, point: nearestPoint(series.points, timestamp) }))
      .filter((item) => item.point)
      .sort((left, right) => {
        if (left.point[1] === null) return 1;
        if (right.point[1] === null) return -1;
        return right.point[1] - left.point[1];
      });
    if (rows.length === 0) {
      hideTooltip();
      return;
    }
    refs.tooltip.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = formatDateTime(timestamp, true);
    refs.tooltip.append(heading, ...rows.slice(0, 10).map(({ series, point }) => {
      const row = document.createElement('div');
      row.className = 'tooltip-row';
      const label = document.createElement('span');
      label.textContent = series.label;
      label.style.color = series.color;
      const value = document.createElement('span');
      value.textContent = point[1] === null ? '断线' : formatNumber(point[1]);
      row.append(label, value);
      return row;
    }));
    refs.tooltip.hidden = false;
    const localX = event.clientX - refs.chartFrame.getBoundingClientRect().left;
    const localY = event.clientY - refs.chartFrame.getBoundingClientRect().top;
    refs.tooltip.style.left = `${clamp(localX + 14, 8, refs.chartFrame.clientWidth - refs.tooltip.offsetWidth - 8)}px`;
    refs.tooltip.style.top = `${clamp(localY + 14, 8, refs.chartFrame.clientHeight - refs.tooltip.offsetHeight - 8)}px`;
    const hoverLine = document.getElementById('hoverLine');
    if (hoverLine) {
      hoverLine.hidden = false;
      hoverLine.setAttribute('x1', String(svgX));
      hoverLine.setAttribute('x2', String(svgX));
    }
  }

  function hideTooltip() {
    refs.tooltip.hidden = true;
    const hoverLine = document.getElementById('hoverLine');
    if (hoverLine) hoverLine.hidden = true;
  }

  function nearestPoint(points, timestamp) {
    if (!points.length) return null;
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (points[middle][0] < timestamp) low = middle + 1;
      else high = middle;
    }
    const current = points[low];
    const previous = points[Math.max(0, low - 1)];
    return Math.abs(previous[0] - timestamp) <= Math.abs(current[0] - timestamp) ? previous : current;
  }

  function setLoading(loading) {
    refs.chartFrame.setAttribute('aria-busy', String(loading));
    if (loading) {
      refs.chartEmpty.hidden = false;
      refs.chartEmpty.textContent = '正在加载历史数据...';
    } else {
      refs.chartEmpty.textContent = '暂无可显示的数据';
    }
  }

  function showNotice(message, error) {
    refs.notice.hidden = false;
    refs.notice.className = `notice${error ? ' error' : ''}`;
    refs.notice.textContent = message;
  }

  function hideNotice() {
    refs.notice.hidden = true;
    refs.notice.textContent = '';
  }

  function findManifestDate(timestamp) {
    return state.manifest.dates.find((item) => timestamp >= item.startMs && timestamp <= item.endMs);
  }

  function formatRangeMinute(minute) {
    const fileIndex = Math.floor(minute / 1440);
    const minuteOfDay = minute % 1440;
    const time = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
    return fileIndex > 0 ? `${state.dateFiles[fileIndex]?.date || '次日'} ${time}` : time;
  }

  function formatDateTime(timestamp, includeDate) {
    const options = {
      timeZone: state.manifest?.timeZone || 'Asia/Shanghai',
      hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    };
    if (includeDate) {
      Object.assign(options, { year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    return new Intl.DateTimeFormat('zh-CN', options).format(new Date(timestamp));
  }

  function formatHistoryDateLabel(date) {
    const parts = date.split('-').map(Number);
    return parts.length === 3 && parts.every(Number.isFinite) ? `${parts[1]}/${parts[2]}` : date;
  }

  function formatSessionDuration(durationMs) {
    const seconds = Math.max(0, Math.floor(Number(durationMs) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function formatAxisTime(timestamp) {
    const includeDate = state.dateFiles.length === 2;
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: state.manifest.timeZone,
      hour12: false,
      ...(includeDate ? { month: '2-digit', day: '2-digit' } : {}),
      hour: '2-digit', minute: '2-digit'
    }).format(new Date(timestamp));
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(value || 0);
  }

  function formatCompact(value) {
    if (value >= 10000) return `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}万`;
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}千`;
    return String(Math.round(value));
  }

  function colorForRoom(roomId, index = -1) {
    if (Number.isInteger(index) && index >= 0) return colorForTrend(index);
    let hash = 2166136261;
    for (const char of roomId) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return colorForTrend(Math.abs(hash));
  }

  function colorForTrend(index) {
    const safeIndex = Math.max(0, Number(index) || 0);
    if (safeIndex < PALETTE.length) return PALETTE[safeIndex];
    const hue = (safeIndex * 137.508) % 360;
    const saturation = safeIndex % 2 === 0 ? 78 : 68;
    const lightness = safeIndex % 3 === 0 ? 60 : 54;
    return `hsl(${hue.toFixed(1)} ${saturation}% ${lightness}%)`;
  }

  function buildYAxisScale(values, plotHeight) {
    const numeric = values.filter(isFiniteNumber);
    if (numeric.length === 0) return { min: 0, max: 5, ticks: [0, 1, 2, 3, 4, 5] };
    const bounds = numeric.reduce((result, value) => ({
      min: Math.min(result.min, value),
      max: Math.max(result.max, value)
    }), { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY });
    const rawSpan = bounds.max - bounds.min;
    const referenceSpan = rawSpan > 0 ? rawSpan : Math.max(1, Math.abs(bounds.max) * 0.1);
    const padding = Math.max(1, referenceSpan * 0.04, Math.abs(bounds.max) * 0.015);
    const useZeroBaseline = bounds.min <= 0 || (bounds.max > 0 && bounds.min <= bounds.max * 0.18);
    const paddedMin = useZeroBaseline ? 0 : Math.max(0, bounds.min - padding);
    const paddedMax = Math.max(paddedMin + 1, bounds.max + padding);
    const targetIntervals = clamp(Math.floor(plotHeight / 50), 4, 8);
    const step = getNiceAxisStep((paddedMax - paddedMin) / targetIntervals);
    const min = useZeroBaseline ? 0 : Math.floor(paddedMin / step) * step;
    const max = Math.max(min + step, Math.ceil(paddedMax / step) * step);
    const ticks = [];
    for (let value = min; value <= max + step / 2; value += step) {
      ticks.push(Number(value.toPrecision(12)));
    }
    return { min, max, ticks };
  }

  function getNiceAxisStep(rawStep) {
    if (!isFiniteNumber(rawStep) || rawStep <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const normalized = rawStep / magnitude;
    const multiplier = [1, 2, 2.5, 5, 10].find((candidate) => normalized <= candidate) || 10;
    return multiplier * magnitude;
  }

  function svgLine(x1, y1, x2, y2, className) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    line.setAttribute('class', className);
    return line;
  }

  function svgText(x, y, value, className, anchor) {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', String(x));
    text.setAttribute('y', String(y));
    text.setAttribute('class', className);
    text.setAttribute('text-anchor', anchor);
    text.textContent = value;
    return text;
  }

  function option(value, label) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    return item;
  }

  function sessionKey(session) {
    return `${session.startMs}:${session.endMs}`;
  }

  function getNextDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
    const [year, month, day] = date.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  }

  function areAdjacentDates(left, right) {
    return getNextDate(left) === right || getNextDate(right) === left;
  }

  function compareRoomIds(left, right) {
    return left.localeCompare(right, undefined, { numeric: true });
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function safeJson(value, fallback) {
    if (typeof value !== 'string') {
      return fallback;
    }
    try {
      return JSON.parse(value) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function restoreState() {
    const saved = safeJson(localStorage.getItem(STORAGE_KEY), {});
    state.selectedDate = typeof saved.selectedDate === 'string' ? saved.selectedDate : '';
    state.twoDays = Boolean(saved.twoDays);
    state.startMinute = isFiniteNumber(saved.startMinute) ? saved.startMinute : 0;
    state.endMinute = isFiniteNumber(saved.endMinute) ? saved.endMinute : 1439;
    state.roomId = typeof saved.roomId === 'string' ? saved.roomId : '';
    state.sessionId = typeof saved.sessionId === 'string' ? saved.sessionId : '';
    const legacyScopes = Array.isArray(saved.scopes)
      ? saved.scopes.filter((item) => typeof item === 'string')
      : null;
    state.filters = new Set(Array.isArray(saved.filters)
      ? saved.filters.filter((item) => typeof item === 'string') : legacyScopes ?? ['all']);
    state.aggregates = new Set(Array.isArray(saved.aggregates)
      ? saved.aggregates.filter((item) => typeof item === 'string') : legacyScopes ?? []);
    state.hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden.filter((item) => typeof item === 'string') : []);
    state.theme = saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : 'system';
    state.height = isFiniteNumber(saved.height) ? clamp(saved.height, 160, 640) : 480;
  }

  function persistState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      selectedDate: state.selectedDate,
      twoDays: state.twoDays,
      startMinute: state.startMinute,
      endMinute: state.endMinute,
      roomId: state.roomId,
      sessionId: state.sessionId,
      filters: Array.from(state.filters),
      aggregates: Array.from(state.aggregates),
      hidden: Array.from(state.hidden),
      theme: state.theme,
      height: state.height
    }));
  }

  function debounce(callback, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => callback(...args), wait);
    };
  }
})();
