(function () {
  const vscode = acquireVsCodeApi();

  const openSearchButton = document.getElementById('open-search-button');
  const refreshButton = document.getElementById('refresh-button');
  const roomListToggle = document.getElementById('room-list-toggle');
  const controlPanelToggle = document.getElementById('control-panel-toggle');
  const controlPanel = document.getElementById('control-panel');
  const displayModeToggle = document.getElementById('display-mode-toggle');
  const autoRefreshToggle = document.getElementById('auto-refresh-toggle');
  const liveStartNotificationsToggle = document.getElementById('live-start-notifications-toggle');
  const intervalInput = document.getElementById('interval-input');
  const dataRefreshInputs = {
    baseInfoIntervalSeconds: document.getElementById('base-info-interval-input'),
    onlineIntervalSeconds: document.getElementById('online-interval-input'),
    fansIntervalSeconds: document.getElementById('fans-interval-input'),
    guardIntervalSeconds: document.getElementById('guard-interval-input')
  };
  const sortFieldSelect = document.getElementById('sort-field-select');
  const sortDirectionToggle = document.getElementById('sort-direction-toggle');
  const filterAllButton = document.getElementById('filter-all-button');
  const filterLiveButton = document.getElementById('filter-live-button');
  const filterOfflineButton = document.getElementById('filter-offline-button');
  const createGroupButton = document.getElementById('create-group-button');
  const groupManager = document.getElementById('group-manager');
  const trendToggle = document.getElementById('trend-toggle');
  const overviewTrendToggle = document.getElementById('overview-trend-toggle');
  const historyTrendToggle = document.getElementById('history-trend-toggle');
  const trendWindowRange = document.getElementById('trend-window-range');
  const trendWindowLabel = document.getElementById('trend-window-label');
  const summary = document.getElementById('summary');
  const roomListPanel = document.getElementById('room-list-panel');
  const roomListContent = document.getElementById('room-list-content');
  const overviewTrend = document.getElementById('overview-trend');
  const overviewTrendContent = document.getElementById('overview-trend-content');
  const historyTrend = document.getElementById('history-trend');
  const historyTrendContent = document.getElementById('history-trend-content');
  const rooms = document.getElementById('rooms');

  const TREND_WINDOW_MIN_MINUTES = 1;
  const TREND_WINDOW_MAX_MINUTES = 6 * 60;
  const TREND_WINDOW_DEFAULT_MINUTES = TREND_WINDOW_MIN_MINUTES;
  const DATA_REFRESH_DEFAULTS = {
    baseInfoIntervalSeconds: 15,
    onlineIntervalSeconds: 15,
    fansIntervalSeconds: 300,
    guardIntervalSeconds: 60
  };
  const TREND_CHART_MIN_WIDTH = 360;
  const TREND_CHART_HEIGHT = 86;
  const OVERVIEW_CHART_MIN_WIDTH = 360;
  const AGGREGATE_CHART_DEFAULT_HEIGHT = 240;
  const AGGREGATE_CHART_MIN_HEIGHT = 160;
  const AGGREGATE_CHART_MAX_HEIGHT = 640;
  const HISTORY_DAY_START_MINUTE = 0;
  const HISTORY_DAY_END_MINUTE = 23 * 60 + 59;
  const OVERVIEW_RANGE_MODES = ['all', 'live', 'withData'];
  const HISTORY_RANGE_MODES = ['all', 'withData'];
  const GROUP_SCOPE_PREFIX = 'group:';
  const ALL_GROUP_KEY = 'all';
  const AGGREGATE_SERIES_ID_PREFIX = '__scope_total__:';
  const AGGREGATE_TREND_COLORS = [
    'var(--vscode-editor-foreground)',
    'var(--vscode-charts-purple)',
    'var(--vscode-charts-orange)',
    'var(--vscode-charts-blue)',
    'var(--vscode-charts-green)',
    'var(--vscode-charts-red)',
    'var(--vscode-charts-yellow)'
  ];
  const OVERVIEW_TREND_COLORS = [
    'var(--vscode-charts-blue)',
    'var(--vscode-charts-green)',
    'var(--vscode-charts-yellow)',
    'var(--vscode-charts-red)',
    'var(--vscode-charts-purple)',
    'var(--vscode-charts-orange)'
  ];
  const persistedState = normalizePersistedState(vscode.getState?.());

  let currentHistoryDatesRequestId = 0;
  let currentHistoryDateRequestId = 0;
  let latestSnapshot = undefined;
  let trendsExpanded = persistedState.trendsExpanded;
  let trendWindowMinutes = persistedState.trendWindowMinutes;
  let overviewTrendExpanded = persistedState.overviewTrendExpanded;
  let overviewTrendWindowMinutes = persistedState.overviewTrendWindowMinutes;
  let overviewTrendHeight = persistedState.overviewTrendHeight;
  let overviewRangeScopes = new Set(persistedState.overviewRangeScopes);
  let overviewAggregateScopes = new Set(persistedState.overviewAggregateScopes);
  let overviewHiddenRoomIds = new Set(persistedState.overviewHiddenRoomIds);
  let historyTrendExpanded = persistedState.historyTrendExpanded;
  let historySelectedDate = persistedState.historySelectedDate;
  let historyStartMinute = persistedState.historyStartMinute;
  let historyEndMinute = persistedState.historyEndMinute;
  let historyTrendHeight = persistedState.historyTrendHeight;
  let historyRangeScopes = new Set(persistedState.historyRangeScopes);
  let historyAggregateScopes = new Set(persistedState.historyAggregateScopes);
  let historyHiddenRoomIds = new Set(persistedState.historyHiddenRoomIds);
  let historyDates = [];
  let lastHistoryDatesRefreshDate = '';
  let historyData = undefined;
  let historyLoading = false;
  let historyError = '';
  let displayMode = persistedState.displayMode;
  let sortField = persistedState.sortField;
  let sortDirection = persistedState.sortDirection;
  let statusFilter = persistedState.statusFilter;
  let roomListExpanded = persistedState.roomListExpanded;
  let controlPanelExpanded = persistedState.controlPanelExpanded;
  let collapsedGroupKeys = new Set(persistedState.collapsedGroupKeys);
  let openRoomGroupEditors = new Set(persistedState.openRoomGroupEditors);
  let durationTicker = undefined;
  const responsiveChartCleanups = [];

  openSearchButton.addEventListener('click', () => {
    vscode.postMessage({ type: 'openAddRoomPicker' });
  });

  refreshButton.addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });

  roomListToggle.addEventListener('click', () => {
    roomListExpanded = !roomListExpanded;
    updateSubpanelToggle(roomListPanel, roomListContent, roomListToggle, roomListExpanded, '直播间列表');
    persistUiState();
  });

  controlPanelToggle.addEventListener('click', () => {
    controlPanelExpanded = !controlPanelExpanded;
    updateControlPanelState();
    persistUiState();
  });

  displayModeToggle.addEventListener('click', () => {
    displayMode = displayMode === 'detail' ? 'compact' : 'detail';
    rerenderLatestSnapshot();
  });

  autoRefreshToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleAutoRefresh', enabled: autoRefreshToggle.checked });
  });

  liveStartNotificationsToggle.addEventListener('change', () => {
    vscode.postMessage({
      type: 'toggleLiveStartNotifications',
      enabled: liveStartNotificationsToggle.checked
    });
  });

  intervalInput.addEventListener('change', () => {
    const intervalSeconds = Math.max(15, Math.floor(Number(intervalInput.value) || 15));
    intervalInput.value = String(intervalSeconds);
    vscode.postMessage({ type: 'setInterval', intervalSeconds });
  });

  for (const [kind, input] of Object.entries(dataRefreshInputs)) {
    input?.addEventListener('change', () => {
      const fallback = DATA_REFRESH_DEFAULTS[kind];
      const intervalSeconds = Math.max(15, Math.floor(Number(input.value) || fallback));
      input.value = String(intervalSeconds);
      vscode.postMessage({ type: 'setDataRefreshInterval', kind, intervalSeconds });
    });
  }

  sortFieldSelect.addEventListener('change', () => {
    sortField = sortFieldSelect.value;
    rerenderLatestSnapshot();
  });

  sortDirectionToggle.addEventListener('click', () => {
    sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
    rerenderLatestSnapshot();
  });

  filterAllButton.addEventListener('click', () => {
    statusFilter = 'all';
    rerenderLatestSnapshot();
  });

  filterLiveButton.addEventListener('click', () => {
    statusFilter = 'live';
    rerenderLatestSnapshot();
  });

  filterOfflineButton.addEventListener('click', () => {
    statusFilter = 'offline';
    rerenderLatestSnapshot();
  });

  createGroupButton.addEventListener('click', () => {
    vscode.postMessage({ type: 'openCreateGroupInput' });
  });

  trendToggle.addEventListener('click', () => {
    trendsExpanded = !trendsExpanded;
    rerenderLatestSnapshot();
  });

  overviewTrendToggle.addEventListener('click', () => {
    overviewTrendExpanded = !overviewTrendExpanded;
    overviewTrend.classList.toggle('collapsed', !overviewTrendExpanded);
    updateAggregateTrendToggle(overviewTrendToggle, overviewTrendExpanded, '主播总览');
    rerenderLatestSnapshot();
  });

  historyTrendToggle.addEventListener('click', () => {
    historyTrendExpanded = !historyTrendExpanded;
    historyTrend.classList.toggle('collapsed', !historyTrendExpanded);
    if (historyTrendExpanded) {
      requestHistoryDates();
    }
    updateAggregateTrendToggle(historyTrendToggle, historyTrendExpanded, '历史走势');
    rerenderLatestSnapshot();
  });

  trendWindowRange.addEventListener('input', () => {
    const minutes = clampTrendWindowMinutes(Number(trendWindowRange.value));
    trendWindowRange.value = String(minutes);
    trendWindowLabel.textContent = formatTrendWindowMinutesLabel(minutes);
  });

  trendWindowRange.addEventListener('change', () => {
    commitTrendWindowRange(Number(trendWindowRange.value));
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'snapshot') {
      latestSnapshot = message.snapshot;
      render(message.snapshot);
      refreshHistoryDatesAfterDateChange(message.snapshot);
    }
    if (message.type === 'historyDates') {
      handleHistoryDates(message);
    }
    if (message.type === 'historyDate') {
      handleHistoryDate(message);
    }
  });

  updateControlPanelState();
  updateDisplayModeControl();
  updateSortFilterControls();
  updateTrendControls({ lastRefreshAt: Date.now() });
  if (historyTrendExpanded) {
    requestHistoryDates();
  }
  durationTicker = setInterval(updateDurationDisplays, 1000);
  vscode.postMessage({ type: 'ready' });

  function requestHistoryDates() {
    currentHistoryDatesRequestId += 1;
    historyLoading = true;
    historyError = '';
    vscode.postMessage({
      type: 'loadHistoryDates',
      requestId: currentHistoryDatesRequestId
    });
    renderHistoryTrend();
  }

  function ensureHistoryTrendExpanded() {
    if (historyTrendExpanded) {
      return;
    }

    historyTrendExpanded = true;
    updateAggregateTrendToggle(historyTrendToggle, historyTrendExpanded, '历史走势');
    persistUiState();
  }

  function formatLocalDateKey(timestampMs) {
    const date = new Date(timestampMs);
    if (!Number.isFinite(date.getTime())) {
      return '';
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function shouldReloadHistoryDates(historyExpanded, previousDate, currentDate) {
    return Boolean(historyExpanded && previousDate && currentDate && previousDate !== currentDate);
  }

  function refreshHistoryDatesAfterDateChange(snapshot) {
    const currentDate = formatLocalDateKey(snapshot?.lastRefreshAt);
    const shouldReload = shouldReloadHistoryDates(
      historyTrendExpanded,
      lastHistoryDatesRefreshDate,
      currentDate
    );
    if (currentDate) {
      lastHistoryDatesRefreshDate = currentDate;
    }
    if (shouldReload) {
      requestHistoryDates();
    }
  }

  function requestHistoryDate() {
    if (!historySelectedDate) {
      return;
    }

    ensureHistoryTrendExpanded();
    currentHistoryDateRequestId += 1;
    historyLoading = true;
    historyError = '';
    vscode.postMessage({
      type: 'loadHistoryDate',
      requestId: currentHistoryDateRequestId,
      date: historySelectedDate,
      startMinute: historyStartMinute,
      endMinute: historyEndMinute
    });
    renderHistoryTrend();
  }

  function handleHistoryDates(message) {
    if (message.requestId !== currentHistoryDatesRequestId) {
      return;
    }

    historyDates = Array.isArray(message.dates) ? message.dates : [];
    historyError = message.error || '';
    historyLoading = false;

    if (!historySelectedDate || !historyDates.some((item) => item.date === historySelectedDate)) {
      historySelectedDate = historyDates.length > 0 ? historyDates[historyDates.length - 1].date : '';
      historyData = undefined;
      historyHiddenRoomIds.clear();
    }

    persistUiState();
    if (historySelectedDate) {
      requestHistoryDate();
    } else {
      renderHistoryTrend();
    }
  }

  function handleHistoryDate(message) {
    if (message.requestId !== currentHistoryDateRequestId) {
      return;
    }

    historyData = normalizeHistoryQueryResult(message.history, historySelectedDate);
    historyError = message.error || '';
    historyLoading = false;
    pruneHistoryHiddenRoomIds(historyData.rooms);
    persistUiState();
    renderHistoryTrend();
  }

  function render(snapshot) {
    latestSnapshot = snapshot;
    cleanupResponsiveCharts();
    autoRefreshToggle.checked = snapshot.settings.autoRefreshEnabled;
    liveStartNotificationsToggle.checked = snapshot.settings.liveStartNotificationsEnabled;
    intervalInput.value = String(snapshot.settings.autoRefreshIntervalSeconds);
    const dataRefresh = snapshot.settings.dataRefresh || DATA_REFRESH_DEFAULTS;
    for (const [kind, input] of Object.entries(dataRefreshInputs)) {
      if (input) {
        input.value = String(Math.max(15, Number(dataRefresh[kind]) || DATA_REFRESH_DEFAULTS[kind]));
      }
    }
    refreshButton.disabled = snapshot.loading;
    updateDisplayModeControl();
    updateSortFilterControls();
    updateGroupControls(snapshot);
    ensureTrendScopes(snapshot);
    updateTrendControls(snapshot);
    updateSubpanelToggle(roomListPanel, roomListContent, roomListToggle, roomListExpanded, '直播间列表');
    renderOverviewTrend(snapshot);
    renderHistoryTrend();

    const liveCount = snapshot.rooms.filter((room) => room.status === 'live').length;
    const visibleRooms = getVisibleRooms(snapshot);
    summary.innerHTML = '';
    summary.append(
      pill(`监控 ${snapshot.settings.rooms.length}`),
      pill(`直播中 ${liveCount}`),
      pill(`显示 ${visibleRooms.length}`),
      pill(`刷新 ${snapshot.lastRefreshText}`),
      refreshStatusPill(snapshot)
    );

    rooms.innerHTML = '';
    rooms.className = `rooms mode-${displayMode}`;
    if (snapshot.rooms.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = snapshot.message || '暂无直播间';
      rooms.append(empty);
      return;
    }

    const trendWindow = getTrendWindow(snapshot);
    rooms.append(buildRoomGroupSection(ALL_GROUP_KEY, '全部', visibleRooms, snapshot, trendWindow));

    for (const group of getCustomGroups(snapshot)) {
      const groupRoomIds = new Set(group.rooms || []);
      const groupRooms = visibleRooms.filter((room) => groupRoomIds.has(room.roomId));
      rooms.append(buildRoomGroupSection(getGroupKey(group.id), group.name, groupRooms, snapshot, trendWindow));
    }
  }

  function rerenderLatestSnapshot() {
    persistUiState();
    if (latestSnapshot) {
      render(latestSnapshot);
    }
  }

  function updateAggregateTrendToggle(toggle, expanded, label) {
    const panel = toggle.closest('.subpanel');
    const contentId = toggle.getAttribute('aria-controls');
    const content = contentId ? document.getElementById(contentId) : undefined;
    if (panel && content) {
      updateSubpanelToggle(panel, content, toggle, expanded, label);
      return;
    }
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? `收起${label}` : `展开${label}`);
    toggle.title = expanded ? `收起${label}` : `展开${label}`;
    toggle.classList.toggle('expanded', expanded);
  }

  function updateSubpanelToggle(panel, content, toggle, expanded, label) {
    panel.classList.toggle('collapsed', !expanded);
    content.classList.toggle('hidden', !expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? `收起${label}` : `展开${label}`);
    toggle.title = expanded ? `收起${label}` : `展开${label}`;
    toggle.classList.toggle('expanded', expanded);
  }

  function buildRoomGroupSection(key, title, groupRooms, snapshot, trendWindow) {
    const section = document.createElement('section');
    section.className = 'room-group';
    section.classList.toggle('is-collapsed', collapsedGroupKeys.has(key));

    const header = document.createElement('button');
    header.type = 'button';
    header.className = `room-group-header ${displayMode === 'compact' ? 'is-compact' : 'is-detail'}`;
    header.title = collapsedGroupKeys.has(key) ? '展开分组' : '折叠分组';
    header.setAttribute('aria-expanded', String(!collapsedGroupKeys.has(key)));
    header.addEventListener('click', () => {
      toggleCollapsedGroup(key);
    });

    const caret = document.createElement('span');
    caret.className = 'room-group-caret';
    caret.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'room-group-name';
    name.textContent = title;

    const totalOnline = document.createElement('span');
    totalOnline.className = 'room-group-total room-group-total-online';
    totalOnline.textContent = formatNumber(sumGroupMetric(groupRooms, (room) => room.online));
    totalOnline.title = `${title} · 总在线人数`;

    const totalGuardFleet = document.createElement('span');
    totalGuardFleet.className = 'room-group-total room-group-total-guard';
    totalGuardFleet.textContent = formatNumber(sumGroupMetric(groupRooms, (room) => room.guardFleet?.total));
    totalGuardFleet.title = `${title} · 舰队总人数`;

    const count = document.createElement('span');
    count.className = 'room-group-count';
    const liveCount = groupRooms.filter((room) => room.status === 'live').length;
    count.textContent = `${liveCount}/${groupRooms.length}`;
    count.title = `${title} · 开播 ${liveCount} / 总计 ${groupRooms.length}`;

    header.append(caret, name, totalOnline, totalGuardFleet, count);
    section.append(header);

    if (collapsedGroupKeys.has(key)) {
      return section;
    }

    const body = document.createElement('div');
    body.className = 'room-group-body';
    if (groupRooms.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'room-group-empty';
      empty.textContent = key === ALL_GROUP_KEY ? '当前筛选没有匹配主播' : '该分组暂无匹配主播';
      body.append(empty);
    } else {
      for (const room of groupRooms) {
        body.append(
          displayMode === 'compact'
            ? compactRoomRow(room, snapshot, trendWindow)
            : roomCard(room, snapshot, trendWindow)
        );
      }
    }

    section.append(body);
    return section;
  }

  function sumGroupMetric(groupRooms, getValue) {
    return groupRooms.reduce((total, room) => {
      const value = getValue(room);
      return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    }, 0);
  }

  function toggleCollapsedGroup(key) {
    if (collapsedGroupKeys.has(key)) {
      collapsedGroupKeys.delete(key);
    } else {
      collapsedGroupKeys.add(key);
    }

    rerenderLatestSnapshot();
  }

  function toggleRoomGroupEditor(roomId) {
    if (openRoomGroupEditors.has(roomId)) {
      openRoomGroupEditors.delete(roomId);
    } else {
      openRoomGroupEditors.add(roomId);
    }

    rerenderLatestSnapshot();
  }

  function roomGroupEditor(room, snapshot) {
    const editor = document.createElement('div');
    editor.className = 'room-group-editor';

    const groups = getCustomGroups(snapshot);
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'room-group-editor-empty';
      empty.textContent = '暂无自定义分组';
      editor.append(empty);
      return editor;
    }

    const selectedGroupIds = new Set(groups.filter((group) => (group.rooms || []).includes(room.roomId)).map((group) => group.id));
    for (const group of groups) {
      const label = document.createElement('label');
      label.className = 'room-group-choice';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedGroupIds.has(group.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedGroupIds.add(group.id);
        } else {
          selectedGroupIds.delete(group.id);
        }

        vscode.postMessage({
          type: 'setRoomGroups',
          roomId: room.roomId,
          groupIds: Array.from(selectedGroupIds)
        });
      });

      const text = document.createElement('span');
      text.textContent = group.name;
      label.append(checkbox, text);
      editor.append(label);
    }

    return editor;
  }

  function commitTrendWindowRange(value) {
    const minutes = clampTrendWindowMinutes(value);
    trendWindowRange.value = String(minutes);
    trendWindowLabel.textContent = formatTrendWindowMinutesLabel(minutes);
    if (trendWindowMinutes === minutes) {
      persistUiState();
      return;
    }

    trendWindowMinutes = minutes;
    rerenderLatestSnapshot();
  }

  function commitOverviewTrendWindowRange(value) {
    const minutes = clampTrendWindowMinutes(value);
    if (overviewTrendWindowMinutes === minutes) {
      persistUiState();
      return;
    }

    overviewTrendWindowMinutes = minutes;
    rerenderLatestSnapshot();
  }

  function buildAggregateChartHeightControl(chartKind) {
    const isOverview = chartKind === 'overview';
    const currentHeight = isOverview ? overviewTrendHeight : historyTrendHeight;
    const field = document.createElement('label');
    field.className = 'overview-range-field aggregate-chart-height-field';

    const valueLabel = document.createElement('span');
    valueLabel.className = 'trend-field-value';
    valueLabel.textContent = `${currentHeight}px`;

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(AGGREGATE_CHART_MIN_HEIGHT);
    range.max = String(AGGREGATE_CHART_MAX_HEIGHT);
    range.step = '10';
    range.value = String(currentHeight);
    range.setAttribute('aria-label', `${isOverview ? '主播总览' : '历史走势'}图表高度`);
    range.addEventListener('input', () => {
      const height = clampAggregateChartHeight(Number(range.value));
      range.value = String(height);
      valueLabel.textContent = `${height}px`;
    });
    range.addEventListener('change', () => {
      commitAggregateChartHeight(chartKind, Number(range.value));
    });

    field.append(buildTrendFieldHeading('图表高度', valueLabel), range);
    return field;
  }

  function commitAggregateChartHeight(chartKind, value) {
    const height = clampAggregateChartHeight(value);
    if (chartKind === 'overview') {
      overviewTrendHeight = height;
      rerenderLatestSnapshot();
      return;
    }

    historyTrendHeight = height;
    persistUiState();
    renderHistoryTrend();
  }

  function cleanupResponsiveCharts() {
    while (responsiveChartCleanups.length > 0) {
      const cleanup = responsiveChartCleanups.pop();
      cleanup?.();
    }
  }

  function pill(text) {
    const element = document.createElement('span');
    element.className = 'pill';
    element.textContent = text;
    return element;
  }

  function refreshStatusPill(snapshot) {
    const state = getRefreshState(snapshot);
    const element = document.createElement('span');
    element.className = `pill refresh-status ${state.kind}`;

    const dot = document.createElement('span');
    dot.className = 'summary-dot';

    const text = document.createElement('span');
    text.textContent = state.text;

    element.append(dot, text);
    return element;
  }

  function roomCard(room, snapshot, trendWindow) {
    const card = document.createElement('article');
    card.className = `room ${trendsExpanded ? 'with-trend' : ''}`;

    const statusDot = document.createElement('span');
    statusDot.className = `live-dot ${liveDotClass(room.status)}`;
    statusDot.title = liveDotTitle(room.status);

    const content = document.createElement('div');
    content.className = 'room-content';

    const anchor = document.createElement('div');
    anchor.className = 'anchor';
    anchor.textContent = `${room.anchorName || '-'} · ${room.roomId}`;

    const anchorMeta = document.createElement('div');
    anchorMeta.className = 'anchor-meta';
    const fansValue = document.createElement('span');
    fansValue.textContent = formatNullableNumber(room.fansCount);
    applyCachedMetricState(fansValue, room.fansCountStale, room.fansCountLastSuccessAt, '粉丝数');
    anchorMeta.append(document.createTextNode('粉丝 '), fansValue);

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = room.title || '-';

    content.append(anchor, anchorMeta, title);

    const liveStatus = document.createElement('span');
    liveStatus.className = `status status-${room.status}`;
    liveStatus.textContent = statusText(room.status);

    const online = document.createElement('div');
    online.className = 'compact-metric online-metric';
    const onlineValue = metricValue(room.online === null ? '-' : formatNumber(room.online));
    applyCachedMetricState(onlineValue, room.onlineStale, room.onlineLastSuccessAt, '在线人数');
    online.append(metricLabel('在线'), onlineValue);

    const duration = document.createElement('div');
    duration.className = 'compact-metric duration-metric';
    duration.append(metricLabel('时长'), durationValue(room));

    const guardFleet = document.createElement('div');
    guardFleet.className = 'compact-metric guard-metric';
    const guardValue = metricValue(formatGuardFleet(room.guardFleet));
    applyCachedMetricState(guardValue, room.guardFleetStale, room.guardFleetLastSuccessAt, '舰队人数');
    guardFleet.append(metricLabel('舰队'), guardValue);

    const actions = document.createElement('div');
    actions.className = 'room-actions';
    actions.append(actionButton('分', '设置分组', () => toggleRoomGroupEditor(room.roomId)));
    actions.append(actionButton('↗', '打开直播间', () => vscode.postMessage({ type: 'openRoom', roomId: room.roomId })));
    actions.append(actionButton('×', '删除直播间', () => {
      openRoomGroupEditors.delete(room.roomId);
      vscode.postMessage({ type: 'removeRoom', roomId: room.roomId });
    }));

    card.append(statusDot, content, liveStatus, online, duration, guardFleet, actions);

    if (room.error) {
      const error = document.createElement('div');
      error.className = 'error';
      error.textContent = room.error;
      card.append(error);
    }

    if (openRoomGroupEditors.has(room.roomId)) {
      card.append(roomGroupEditor(room, snapshot));
    }

    if (trendsExpanded) {
      card.append(trendPanel(room, snapshot, trendWindow));
    }

    return card;
  }

  function compactRoomRow(room, snapshot, trendWindow) {
    const row = document.createElement('article');
    row.className = `room-compact ${trendsExpanded ? 'with-trend' : ''}`;

    const statusDot = document.createElement('span');
    statusDot.className = `live-dot ${liveDotClass(room.status)}`;
    statusDot.title = liveDotTitle(room.status);

    const anchor = document.createElement('div');
    anchor.className = 'compact-anchor';
    anchor.textContent = room.anchorName || '-';
    anchor.title = `${room.anchorName || '-'} · ${room.roomId}`;

    const online = document.createElement('div');
    online.className = 'compact-column compact-online';
    online.textContent = room.online === null ? '-' : formatNumber(room.online);
    applyCachedMetricState(online, room.onlineStale, room.onlineLastSuccessAt, '在线人数');
    if (!room.onlineStale) {
      online.title = '在线人数';
    }

    const guardFleet = document.createElement('div');
    guardFleet.className = 'compact-column compact-guard';
    guardFleet.textContent = formatGuardFleet(room.guardFleet);
    applyCachedMetricState(guardFleet, room.guardFleetStale, room.guardFleetLastSuccessAt, '舰队人数');
    if (!room.guardFleetStale) {
      guardFleet.title = '舰队人数';
    }

    const duration = document.createElement('div');
    duration.className = 'compact-column compact-duration duration-value';
    bindDurationValue(duration, room);
    duration.title = '直播时长';

    const actions = document.createElement('div');
    actions.className = 'compact-actions';
    actions.append(actionButton('分', '设置分组', () => toggleRoomGroupEditor(room.roomId)));

    row.append(statusDot, anchor, online, guardFleet, duration, actions);

    if (room.error) {
      const error = document.createElement('div');
      error.className = 'compact-error';
      error.textContent = room.error;
      row.append(error);
    }

    if (openRoomGroupEditors.has(room.roomId)) {
      row.append(roomGroupEditor(room, snapshot));
    }

    if (trendsExpanded) {
      row.append(trendPanel(room, snapshot, trendWindow));
    }

    return row;
  }

  function trendPanel(room, snapshot, trendWindow) {
    const panel = document.createElement('div');
    panel.className = 'trend-panel';

    const history = snapshot.onlineHistory?.[room.roomId] || [];
    const chart = buildTrendChart(history, trendWindow);
    panel.append(chart);
    return panel;
  }

  function buildTrendChart(history, trendWindow) {
    const paddingLeft = 44;
    const paddingRight = 8;
    const paddingTop = 12;
    const paddingBottom = 24;
    const visiblePoints = history.filter(([timestamp]) => timestamp >= trendWindow.start && timestamp <= trendWindow.end);
    const validPoints = visiblePoints.filter(([, online]) => typeof online === 'number');
    const scale = getScaleForPoints(validPoints);

    const wrap = document.createElement('div');
    wrap.className = 'trend-chart';

    if (validPoints.length < 2 || !scale) {
      const placeholder = document.createElement('div');
      placeholder.className = 'trend-placeholder';
      placeholder.textContent = '数据积累中';
      wrap.append(placeholder);
      return wrap;
    }

    observeResponsiveSvg(wrap, TREND_CHART_MIN_WIDTH, (width) => {
      wrap.replaceChildren(
        buildTrendSvg(width, TREND_CHART_HEIGHT, visiblePoints, trendWindow, scale, paddingLeft, paddingRight, paddingTop, paddingBottom)
      );
    });

    return wrap;
  }

  function observeResponsiveSvg(container, minWidth, draw) {
    let lastWidth = 0;
    const redraw = () => {
      const measuredWidth = Math.floor(container.clientWidth || container.getBoundingClientRect().width);
      const width = Math.max(minWidth, measuredWidth || minWidth);
      if (width === lastWidth) {
        return;
      }

      lastWidth = width;
      draw(width);
    };

    redraw();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(redraw);
    observer.observe(container);
    responsiveChartCleanups.push(() => observer.disconnect());
  }

  function buildTrendSvg(width, height, visiblePoints, trendWindow, scale, paddingLeft, paddingRight, paddingTop, paddingBottom) {
    const svg = createSvgElement('svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '在线人数走势');

    appendTrendAxis(svg, scale, trendWindow, width, height, paddingLeft, paddingRight, paddingTop, paddingBottom, 'trend');

    const baseLine = createSvgElement('line');
    baseLine.setAttribute('x1', String(paddingLeft));
    baseLine.setAttribute('x2', String(width - paddingRight));
    baseLine.setAttribute('y1', String(height - paddingBottom));
    baseLine.setAttribute('y2', String(height - paddingBottom));
    baseLine.setAttribute('class', 'trend-baseline');
    svg.append(baseLine);

    for (const segment of buildTrendSegments(visiblePoints, trendWindow, scale, width, height, paddingLeft, paddingRight, paddingTop, paddingBottom)) {
      const path = createSvgElement('path');
      path.setAttribute('d', segment);
      path.setAttribute('class', 'trend-line');
      svg.append(path);
    }

    return svg;
  }

  function buildTrendSegments(points, trendWindow, scale, width, height, paddingLeft, paddingRight, paddingTop, paddingBottom) {
    const segments = [];
    let commands = [];

    for (const [timestamp, online] of points) {
      if (typeof online !== 'number') {
        if (commands.length > 1) {
          segments.push(commands.join(' '));
        }
        commands = [];
        continue;
      }

      const xRatio = (timestamp - trendWindow.start) / Math.max(1, trendWindow.end - trendWindow.start);
      const x = paddingLeft + xRatio * (width - paddingLeft - paddingRight);
      const yRatio = (online - scale.min) / Math.max(1, scale.max - scale.min);
      const y = height - paddingBottom - yRatio * (height - paddingTop - paddingBottom);
      commands.push(`${commands.length === 0 ? 'M' : 'L'} ${formatSvgNumber(x)} ${formatSvgNumber(y)}`);
    }

    if (commands.length > 1) {
      segments.push(commands.join(' '));
    }

    return segments;
  }

  function renderOverviewTrend(snapshot) {
    overviewTrendContent.innerHTML = '';
    overviewTrendContent.classList.toggle('hidden', !overviewTrendExpanded);
    overviewTrend.classList.toggle('collapsed', !overviewTrendExpanded);
    updateAggregateTrendToggle(overviewTrendToggle, overviewTrendExpanded, '主播总览');
    if (!overviewTrendExpanded) {
      return;
    }

    overviewTrendContent.append(buildOverviewTrend(snapshot));
  }

  function buildOverviewTrend(snapshot) {
    const panel = document.createElement('section');
    panel.className = 'overview-trend-panel';

    const header = document.createElement('div');
    header.className = 'overview-trend-header';

    const overviewWindow = getOverviewTrendWindow(snapshot);
    const modeControls = document.createElement('div');
    modeControls.className = 'overview-mode-controls';
    const getOverviewScopeRooms = (scope) =>
      getOverviewCandidateRoomsForScope(snapshot.rooms, snapshot.onlineHistory, overviewWindow, scope);
    appendScopeControl(modeControls, '全部', 'all', 'overview', '加入或移出全部关注直播间', getOverviewScopeRooms('all'), snapshot);
    appendScopeControl(modeControls, '开播', 'live', 'overview', '加入或移出当前正在开播的直播间', getOverviewScopeRooms('live'), snapshot);
    appendScopeControl(modeControls, '有数据', 'withData', 'overview', '加入或移出当前时间范围内有有效采样的直播间', getOverviewScopeRooms('withData'), snapshot);
    appendGroupScopeControls(modeControls, snapshot, 'overview', getOverviewScopeRooms);

    const scopeField = document.createElement('div');
    scopeField.className = 'trend-scope-field';
    scopeField.append(buildTrendFieldHeading('筛选范围'), modeControls);

    const rangeField = document.createElement('label');
    rangeField.className = 'overview-range-field';

    const rangeLabel = document.createElement('span');
    rangeLabel.className = 'trend-field-value';
    rangeLabel.textContent = formatTrendWindowLabel(overviewWindow);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(TREND_WINDOW_MIN_MINUTES);
    range.max = String(TREND_WINDOW_MAX_MINUTES);
    range.step = '1';
    range.value = String(overviewTrendWindowMinutes);
    range.addEventListener('input', () => {
      const minutes = clampTrendWindowMinutes(Number(range.value));
      range.value = String(minutes);
      rangeLabel.textContent = formatTrendWindowMinutesLabel(minutes);
    });
    range.addEventListener('change', () => {
      commitOverviewTrendWindowRange(Number(range.value));
    });

    rangeField.append(buildTrendFieldHeading('时间范围', rangeLabel), range);
    header.append(scopeField, rangeField, buildAggregateChartHeightControl('overview'));
    panel.append(header);

    const candidateRooms = getOverviewCandidateRoomsForScopes(
      snapshot.rooms,
      snapshot.onlineHistory,
      overviewWindow,
      overviewRangeScopes
    );
    const roomColorIndexes = new Map(snapshot.rooms.map((room, index) => [room.roomId, index]));
    const buildRoomSeries = (rooms) => rooms.map((room, index) => ({
      room,
      color: OVERVIEW_TREND_COLORS[(roomColorIndexes.get(room.roomId) ?? index) % OVERVIEW_TREND_COLORS.length],
      points: (snapshot.onlineHistory?.[room.roomId] || []).filter(
        ([timestamp]) => timestamp >= overviewWindow.start && timestamp <= overviewWindow.end
      )
    }));
    const roomSeries = buildRoomSeries(candidateRooms);
    const aggregateSeries = buildAggregateSeries(overviewAggregateScopes, (scope) =>
      buildRoomSeries(getOverviewCandidateRoomsForScope(snapshot.rooms, snapshot.onlineHistory, overviewWindow, scope)), snapshot
    );
    const series = [...roomSeries, ...aggregateSeries];
    if (series.length === 0) {
      panel.append(overviewPlaceholder(getOverviewEmptyText(), overviewTrendHeight));
      return panel;
    }

    pruneOverviewHiddenRoomIds(snapshot);
    const visibleSeries = series.filter((item) => !overviewHiddenRoomIds.has(item.room.roomId));
    const validPoints = visibleSeries.flatMap((item) => item.points.filter(([, online]) => typeof online === 'number'));
    const scale = getScaleForPoints(validPoints);
    const hasDrawableLine = visibleSeries.some(
      (item) => item.points.filter(([, online]) => typeof online === 'number').length >= 2
    );

    if (visibleSeries.length === 0) {
      panel.append(overviewPlaceholder('已隐藏全部主播', overviewTrendHeight));
      panel.append(overviewLegend(series, overviewHiddenRoomIds, toggleOverviewSeries));
      return panel;
    }

    if (!hasDrawableLine || !scale) {
      panel.append(overviewPlaceholder('数据积累中', overviewTrendHeight));
      panel.append(overviewLegend(series, overviewHiddenRoomIds, toggleOverviewSeries));
      return panel;
    }

    panel.append(buildOverviewChart(visibleSeries, overviewWindow, scale, overviewTrendHeight), overviewLegend(series, overviewHiddenRoomIds, toggleOverviewSeries));
    return panel;
  }

  function renderHistoryTrend() {
    historyTrendContent.innerHTML = '';
    historyTrendContent.classList.toggle('hidden', !historyTrendExpanded);
    historyTrend.classList.toggle('collapsed', !historyTrendExpanded);
    updateAggregateTrendToggle(historyTrendToggle, historyTrendExpanded, '历史走势');
    if (!historyTrendExpanded) {
      return;
    }

    try {
      historyTrendContent.append(buildHistoryTrend());
    } catch (error) {
      const detail = error instanceof Error && error.message ? `：${error.message}` : '';
      console.error('历史走势渲染失败', error);
      historyTrendContent.append(overviewPlaceholder(`历史走势渲染失败${detail}`, historyTrendHeight));
    }
  }

  function normalizeHistoryQueryResult(value, fallbackDate = '') {
    const safeValue = value && typeof value === 'object' ? value : {};
    const date = typeof safeValue.date === 'string' ? safeValue.date : fallbackDate;
    const startMs = Number.isFinite(safeValue.startMs) ? safeValue.startMs : 0;
    const endMs = Number.isFinite(safeValue.endMs) ? safeValue.endMs : startMs;
    const rooms = (Array.isArray(safeValue.rooms) ? safeValue.rooms : [])
      .map((room) => {
        if (!room || typeof room !== 'object') {
          return undefined;
        }

        const roomId = String(room.roomId ?? '').trim();
        if (!roomId) {
          return undefined;
        }

        const anchorName = typeof room.anchorName === 'string' && room.anchorName.trim()
          ? room.anchorName.trim()
          : roomId;
        const pointsByTimestamp = new Map();
        for (const point of Array.isArray(room.points) ? room.points : []) {
          if (!Array.isArray(point) || point.length !== 2) {
            continue;
          }

          const timestamp = point[0];
          const online = point[1];
          if (!Number.isFinite(timestamp)) {
            continue;
          }
          if (online !== null && !(typeof online === 'number' && Number.isFinite(online) && online >= 0)) {
            continue;
          }
          pointsByTimestamp.set(timestamp, [timestamp, online]);
        }

        return {
          roomId,
          anchorName,
          points: Array.from(pointsByTimestamp.values()).sort((left, right) => left[0] - right[0])
        };
      })
      .filter(Boolean);

    return { date, startMs, endMs, rooms };
  }

  function buildHistoryTrend() {
    const panel = document.createElement('section');
    panel.className = 'overview-trend-panel history-trend-panel';

    const header = document.createElement('div');
    header.className = 'history-trend-header';

    const modeControls = document.createElement('div');
    modeControls.className = 'overview-mode-controls history-mode-controls';
    const historyRooms = Array.isArray(historyData?.rooms) ? historyData.rooms : [];
    const getHistoryScopeRooms = (scope) => getHistoryCandidateRoomsForScope(historyRooms, scope);
    appendScopeControl(modeControls, '全部', 'all', 'history', '加入或移出所选日期和时间段内的全部直播间历史', getHistoryScopeRooms('all'), latestSnapshot);
    appendScopeControl(modeControls, '有数据', 'withData', 'history', '加入或移出所选时间段内存在大于 0 在线人数采样的直播间', getHistoryScopeRooms('withData'), latestSnapshot);
    appendGroupScopeControls(modeControls, latestSnapshot, 'history', getHistoryScopeRooms);

    const scopeField = document.createElement('div');
    scopeField.className = 'trend-scope-field';
    scopeField.append(buildTrendFieldHeading('筛选范围'), modeControls);

    const datePicker = buildHistoryCalendar();
    const timeControls = buildHistoryTimeControls();
    header.append(scopeField, datePicker, timeControls, buildAggregateChartHeightControl('history'));
    panel.append(header);

    if (historyLoading) {
      panel.append(overviewPlaceholder('正在读取历史数据', historyTrendHeight));
      return panel;
    }

    if (historyError) {
      panel.append(overviewPlaceholder(historyError, historyTrendHeight));
      return panel;
    }

    if (historyDates.length === 0) {
      panel.append(overviewPlaceholder('暂无本地历史数据', historyTrendHeight));
      return panel;
    }

    if (!historySelectedDate || !historyData) {
      panel.append(overviewPlaceholder('请选择有数据的日期', historyTrendHeight));
      return panel;
    }

    const historyWindow = {
      start: historyData.startMs,
      end: Math.max(historyData.startMs, historyData.endMs),
      windowMinutes: Math.max(1, Math.round((Math.max(historyData.startMs, historyData.endMs) - historyData.startMs + 1) / 60000))
    };
    const candidateRooms = getHistoryCandidateRoomsForScopes(historyRooms, historyRangeScopes);
    const roomColorIndexes = new Map(historyRooms.map((room, index) => [room.roomId, index]));
    const buildRoomSeries = (rooms) => rooms.map((room, index) => ({
      room: {
        roomId: room.roomId,
        anchorName: room.anchorName || room.roomId
      },
      color: OVERVIEW_TREND_COLORS[(roomColorIndexes.get(room.roomId) ?? index) % OVERVIEW_TREND_COLORS.length],
      points: room.points || []
    }));
    const roomSeries = buildRoomSeries(candidateRooms);
    const aggregateSeries = buildAggregateSeries(historyAggregateScopes, (scope) =>
      buildRoomSeries(getHistoryCandidateRoomsForScope(historyRooms, scope)), latestSnapshot
    );
    const series = [...roomSeries, ...aggregateSeries];
    if (series.length === 0) {
      panel.append(overviewPlaceholder(getHistoryEmptyText(), historyTrendHeight));
      return panel;
    }

    const visibleSeries = series.filter((item) => !historyHiddenRoomIds.has(item.room.roomId));
    const validPoints = visibleSeries.flatMap((item) => item.points.filter(([, online]) => typeof online === 'number'));
    const scale = getScaleForPoints(validPoints);
    const hasDrawableLine = visibleSeries.some(
      (item) => item.points.filter(([, online]) => typeof online === 'number').length >= 2
    );

    if (visibleSeries.length === 0) {
      panel.append(overviewPlaceholder('已隐藏全部主播', historyTrendHeight));
      panel.append(overviewLegend(series, historyHiddenRoomIds, toggleHistorySeries));
      return panel;
    }

    if (!hasDrawableLine || !scale) {
      panel.append(overviewPlaceholder('数据积累中', historyTrendHeight));
      panel.append(overviewLegend(series, historyHiddenRoomIds, toggleHistorySeries));
      return panel;
    }

    panel.append(buildOverviewChart(visibleSeries, historyWindow, scale, historyTrendHeight), overviewLegend(series, historyHiddenRoomIds, toggleHistorySeries));
    return panel;
  }

  function buildHistoryCalendar() {
    const field = document.createElement('div');
    field.className = 'history-date-field';

    const input = document.createElement('input');
    input.type = 'date';
    input.setAttribute('aria-label', '历史日期');
    input.value = historySelectedDate || '';
    input.disabled = historyDates.length === 0;
    const availableDates = new Set(historyDates.map((item) => item.date));
    input.addEventListener('change', () => {
      if (!availableDates.has(input.value)) {
        input.value = historySelectedDate || '';
        return;
      }

      historySelectedDate = input.value;
      historyHiddenRoomIds.clear();
      persistUiState();
      ensureHistoryTrendExpanded();
      requestHistoryDate();
    });

    const controls = document.createElement('div');
    controls.className = 'history-date-controls';
    controls.append(input, buildHistoryDateButtons());
    field.append(buildTrendFieldHeading('历史日期'), controls);
    return field;
  }

  function buildHistoryDateButtons() {
    const list = document.createElement('div');
    list.className = 'history-date-list';

    for (const item of historyDates) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-date-button';
      button.classList.toggle('active', item.date === historySelectedDate);
      button.title = `${item.roomIds.length} 个直播间，${item.pointCount} 个采样点`;
      button.textContent = formatHistoryDateLabel(item.date);
      button.addEventListener('click', () => {
        if (historySelectedDate === item.date) {
          return;
        }

        historySelectedDate = item.date;
        historyHiddenRoomIds.clear();
        persistUiState();
        ensureHistoryTrendExpanded();
        requestHistoryDate();
      });
      list.append(button);
    }

    return list;
  }

  function buildHistoryTimeControls() {
    const controls = document.createElement('div');
    controls.className = 'history-time-controls';

    const label = document.createElement('div');
    label.className = 'history-range-label trend-field-value';
    label.textContent = formatHistoryRangeLabel(historyStartMinute, historyEndMinute);

    const slider = document.createElement('div');
    slider.className = 'history-range-slider';

    const track = document.createElement('div');
    track.className = 'history-range-track';

    const selection = document.createElement('div');
    selection.className = 'history-range-selection';
    track.append(selection);

    const startInput = buildHistoryRangeInput('开始时间', historyStartMinute);
    const endInput = buildHistoryRangeInput('结束时间', historyEndMinute);

    const activateHandle = (activeInput) => {
      startInput.style.zIndex = activeInput === startInput ? '3' : '2';
      endInput.style.zIndex = activeInput === endInput ? '3' : '2';
    };

    const updatePreview = (activeInput) => {
      activateHandle(activeInput);
      const start = clampHistoryMinute(Number(startInput.value), HISTORY_DAY_START_MINUTE);
      const end = clampHistoryMinute(Number(endInput.value), HISTORY_DAY_END_MINUTE);
      if (start > end) {
        if (activeInput === startInput) {
          endInput.value = String(start);
        } else {
          startInput.value = String(end);
        }
      }

      label.textContent = formatHistoryRangeLabel(Number(startInput.value), Number(endInput.value));
      updateHistoryRangeSelection(selection, Number(startInput.value), Number(endInput.value));
    };

    const commit = () => {
      const normalized = normalizeHistoryMinuteRange(Number(startInput.value), Number(endInput.value));
      startInput.value = String(normalized.start);
      endInput.value = String(normalized.end);
      historyStartMinute = normalized.start;
      historyEndMinute = normalized.end;
      label.textContent = formatHistoryRangeLabel(historyStartMinute, historyEndMinute);
      updateHistoryRangeSelection(selection, historyStartMinute, historyEndMinute);
      persistUiState();
      requestHistoryDate();
    };

    startInput.addEventListener('input', () => {
      updatePreview(startInput);
    });
    endInput.addEventListener('input', () => {
      updatePreview(endInput);
    });
    startInput.addEventListener('pointerdown', () => {
      activateHandle(startInput);
    });
    endInput.addEventListener('pointerdown', () => {
      activateHandle(endInput);
    });
    startInput.addEventListener('change', commit);
    endInput.addEventListener('change', commit);

    slider.append(track, startInput, endInput);
    updateHistoryRangeSelection(selection, historyStartMinute, historyEndMinute);

    const endpoints = document.createElement('div');
    endpoints.className = 'history-range-endpoints';
    endpoints.append(textSpan('00:00'), textSpan('23:59'));

    controls.append(buildTrendFieldHeading('时间范围', label), slider, endpoints);
    return controls;
  }

  function buildTrendFieldHeading(labelText, valueElement) {
    const heading = document.createElement('div');
    heading.className = 'trend-field-heading';

    const label = document.createElement('span');
    label.className = 'trend-field-label';
    label.textContent = labelText;
    heading.append(label);
    if (valueElement) {
      heading.append(valueElement);
    }
    return heading;
  }

  function buildHistoryRangeInput(label, minuteValue) {
    const input = document.createElement('input');
    input.className = 'history-range-input';
    input.type = 'range';
    input.min = String(HISTORY_DAY_START_MINUTE);
    input.max = String(HISTORY_DAY_END_MINUTE);
    input.step = '1';
    input.value = String(clampHistoryMinute(minuteValue, HISTORY_DAY_START_MINUTE));
    input.setAttribute('aria-label', label);
    input.title = label;
    return input;
  }

  function updateHistoryRangeSelection(selection, startMinute, endMinute) {
    const normalized = normalizeHistoryMinuteRange(startMinute, endMinute);
    const total = HISTORY_DAY_END_MINUTE - HISTORY_DAY_START_MINUTE;
    const left = ((normalized.start - HISTORY_DAY_START_MINUTE) / total) * 100;
    const right = 100 - ((normalized.end - HISTORY_DAY_START_MINUTE) / total) * 100;
    selection.style.left = `${left}%`;
    selection.style.right = `${right}%`;
  }

  function normalizeHistoryMinuteRange(startMinute, endMinute) {
    const start = clampHistoryMinute(startMinute, HISTORY_DAY_START_MINUTE);
    const end = clampHistoryMinute(endMinute, HISTORY_DAY_END_MINUTE);
    if (start <= end) {
      return { start, end };
    }

    return { start: end, end: start };
  }

  function formatHistoryRangeLabel(startMinute, endMinute) {
    const normalized = normalizeHistoryMinuteRange(startMinute, endMinute);
    return `${formatMinuteInput(normalized.start)} - ${formatMinuteInput(normalized.end)}`;
  }

  function historyModeButton(text, mode, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    button.className = 'overview-mode-button';
    button.classList.toggle('active', historyRangeScopes.has(mode));
    button.setAttribute('aria-pressed', String(historyRangeScopes.has(mode)));
    button.addEventListener('click', () => {
      toggleScope(historyRangeScopes, mode);
      persistUiState();
      renderHistoryTrend();
    });
    return button;
  }

  function appendScopeControl(container, text, scope, chartKind, title, scopeRooms, snapshot) {
    const control = document.createElement('div');
    control.className = 'overview-scope-control';
    const displayText = getScopeStatusLabel(text, scopeRooms, snapshot);
    const modeButton = chartKind === 'overview'
      ? overviewModeButton(displayText, scope, title)
      : historyModeButton(displayText, scope, title);
    control.append(modeButton, aggregateScopeButton(scope, chartKind, text));
    container.append(control);
  }

  function appendGroupScopeControls(container, snapshot, chartKind, getRoomsForScope) {
    for (const group of getCustomGroups(snapshot)) {
      const scope = getGroupScope(group.id);
      appendScopeControl(container, group.name, scope, chartKind, `加入或移出分组“${group.name}”`, getRoomsForScope(scope), snapshot);
    }
  }

  function getHistoryCandidateRoomsForScope(historyRooms, scope) {
    if (isGroupScope(scope)) {
      const groupRoomIds = getGroupRoomIdSet(scope);
      return historyRooms.filter((room) => groupRoomIds?.has(room.roomId));
    }

    if (scope === 'withData') {
      return historyRooms.filter((room) => (room.points || []).some(([, online]) => typeof online === 'number' && online > 0));
    }

    return historyRooms;
  }

  function getHistoryCandidateRoomsForScopes(historyRooms, scopes) {
    return mergeRoomsForScopes(historyRooms, scopes, (scope) =>
      getHistoryCandidateRoomsForScope(historyRooms, scope)
    );
  }

  function getHistoryEmptyText() {
    if (historyRangeScopes.size === 0) {
      return '请选择至少一个历史范围';
    }

    return '已选范围在当前时间段暂无历史采样';
  }

  function toggleHistorySeries(roomId) {
    if (historyHiddenRoomIds.has(roomId)) {
      historyHiddenRoomIds.delete(roomId);
    } else {
      historyHiddenRoomIds.add(roomId);
    }
    persistUiState();
    renderHistoryTrend();
  }

  function pruneHistoryHiddenRoomIds(historyRooms) {
    const roomIds = new Set(historyRooms.map((room) => room.roomId));
    for (const scope of historyAggregateScopes) {
      roomIds.add(getAggregateSeriesId(scope));
    }
    let changed = false;
    for (const roomId of historyHiddenRoomIds) {
      if (!roomIds.has(roomId)) {
        historyHiddenRoomIds.delete(roomId);
        changed = true;
      }
    }
    if (changed) {
      persistUiState();
    }
  }

  function overviewModeButton(text, mode, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    button.className = 'overview-mode-button';
    button.classList.toggle('active', overviewRangeScopes.has(mode));
    button.setAttribute('aria-pressed', String(overviewRangeScopes.has(mode)));
    button.addEventListener('click', () => {
      toggleScope(overviewRangeScopes, mode);
      rerenderLatestSnapshot();
    });
    return button;
  }

  function aggregateScopeButton(scope, chartKind, label) {
    const isOverview = chartKind === 'overview';
    const aggregateScopes = isOverview ? overviewAggregateScopes : historyAggregateScopes;
    const enabled = aggregateScopes.has(scope);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Σ';
    button.title = enabled ? `移除“${label}”在线人数合计曲线` : `添加“${label}”在线人数合计曲线`;
    button.setAttribute('aria-label', button.title);
    button.className = 'aggregate-scope-button';
    button.classList.toggle('active', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.addEventListener('click', () => {
      const aggregateSeriesId = getAggregateSeriesId(scope);
      if (aggregateScopes.has(scope)) {
        aggregateScopes.delete(scope);
        (isOverview ? overviewHiddenRoomIds : historyHiddenRoomIds).delete(aggregateSeriesId);
      } else {
        aggregateScopes.add(scope);
      }
      if (isOverview) {
        rerenderLatestSnapshot();
      } else {
        persistUiState();
        renderHistoryTrend();
      }
    });
    return button;
  }

  function buildAggregateSeries(scopes, getRoomSeries, snapshot) {
    return Array.from(scopes).flatMap((scope, index) => {
      const roomSeries = getRoomSeries(scope);
      if (roomSeries.length === 0) {
        return [];
      }
      return [{
        room: {
          roomId: getAggregateSeriesId(scope),
          anchorName: getAggregateSeriesLabel(scope, roomSeries, snapshot)
        },
        color: getAggregateSeriesColor(scope, snapshot, index),
        points: sumSeriesPoints(roomSeries),
        aggregate: true
      }];
    });
  }

  function getAggregateSeriesLabel(scope, roomSeries, snapshot) {
    return getScopeStatusLabel(`${getScopeLabel(scope, snapshot)}合计`, roomSeries, snapshot);
  }

  function getScopeStatusLabel(label, rooms, snapshot) {
    const liveRoomIds = new Set(
      (snapshot?.rooms || []).filter((room) => room.status === 'live').map((room) => room.roomId)
    );
    const liveCount = rooms.filter((item) => liveRoomIds.has(item.room?.roomId || item.roomId)).length;
    return `${label} ${liveCount}/${rooms.length}`;
  }

  function getAggregateSeriesId(scope) {
    return `${AGGREGATE_SERIES_ID_PREFIX}${scope}`;
  }

  function getAggregateSeriesColor(scope, snapshot, fallbackIndex) {
    const builtInIndex = ['all', 'live', 'withData'].indexOf(scope);
    if (builtInIndex >= 0) {
      return AGGREGATE_TREND_COLORS[builtInIndex % AGGREGATE_TREND_COLORS.length];
    }
    const groupIndex = getCustomGroups(snapshot).findIndex((group) => getGroupScope(group.id) === scope);
    const colorIndex = groupIndex >= 0 ? groupIndex + 3 : fallbackIndex;
    return AGGREGATE_TREND_COLORS[colorIndex % AGGREGATE_TREND_COLORS.length];
  }

  function toggleScope(scopes, scope) {
    if (scopes.has(scope)) {
      scopes.delete(scope);
      return;
    }
    scopes.add(scope);
  }

  function sumSeriesPoints(roomSeries) {
    const pointMaps = roomSeries.map((item) => new Map(item.points || []));
    const timestamps = new Set(pointMaps.flatMap((points) => Array.from(points.keys())));
    return Array.from(timestamps)
      .sort((left, right) => left - right)
      .map((timestamp) => {
        const values = pointMaps.map((points) => points.get(timestamp));
        // A missing point means the room had not entered monitoring yet; it contributes zero.
        // An explicit null still means the room was sampled but unavailable, so keep the gap.
        if (values.some((value) => value === null)) {
          return [timestamp, null];
        }
        const numericValues = values.filter((value) => typeof value === 'number');
        if (numericValues.length === 0) {
          return [timestamp, null];
        }
        return [timestamp, numericValues.reduce((total, value) => total + value, 0)];
      });
  }

  function getScopeLabel(scope, snapshot) {
    if (scope === 'live') {
      return '开播主播';
    }
    if (scope === 'withData') {
      return '有数据主播';
    }
    if (isGroupScope(scope)) {
      const groupId = scope.slice(GROUP_SCOPE_PREFIX.length);
      return getCustomGroups(snapshot).find((group) => group.id === groupId)?.name || '分组';
    }
    return '全部主播';
  }

  function getOverviewCandidateRoomsForScope(rooms, onlineHistory, overviewWindow, scope) {
    if (isGroupScope(scope)) {
      const groupRoomIds = getGroupRoomIdSet(scope);
      return rooms.filter((room) => groupRoomIds?.has(room.roomId));
    }

    if (scope === 'live') {
      return rooms.filter((room) => room.status === 'live');
    }

    if (scope === 'withData') {
      return rooms.filter((room) => roomHasValidOverviewPoint(room.roomId, onlineHistory, overviewWindow));
    }

    return rooms;
  }

  function getOverviewCandidateRoomsForScopes(rooms, onlineHistory, overviewWindow, scopes) {
    return mergeRoomsForScopes(rooms, scopes, (scope) =>
      getOverviewCandidateRoomsForScope(rooms, onlineHistory, overviewWindow, scope)
    );
  }

  function mergeRoomsForScopes(rooms, scopes, getRoomsForScope) {
    if (scopes.size === 0) {
      return [];
    }

    const selectedRoomIds = new Set();
    for (const scope of scopes) {
      for (const room of getRoomsForScope(scope)) {
        selectedRoomIds.add(room.roomId);
      }
    }
    return rooms.filter((room) => selectedRoomIds.has(room.roomId));
  }

  function roomHasValidOverviewPoint(roomId, onlineHistory, overviewWindow) {
    return (onlineHistory?.[roomId] || []).some(
      ([timestamp, online]) =>
        timestamp >= overviewWindow.start && timestamp <= overviewWindow.end && typeof online === 'number' && online > 0
    );
  }

  function getOverviewEmptyText() {
    if (overviewRangeScopes.size === 0) {
      return '请选择至少一个主播范围';
    }

    return '已选范围暂无可展示的直播间';
  }

  function overviewPlaceholder(text, height = AGGREGATE_CHART_DEFAULT_HEIGHT) {
    const placeholder = document.createElement('div');
    placeholder.className = 'overview-placeholder';
    placeholder.textContent = text;
    placeholder.style.height = `${clampAggregateChartHeight(height) + 2}px`;
    return placeholder;
  }

  function buildOverviewChart(series, trendWindow, scale, height = AGGREGATE_CHART_DEFAULT_HEIGHT) {
    const paddingLeft = 56;
    const paddingRight = 14;
    const paddingTop = 22;
    const paddingBottom = 32;
    const chart = document.createElement('div');
    chart.className = 'overview-chart';
    const chartHeight = clampAggregateChartHeight(height);
    const chartScale = getAggregateChartScale(scale);
    chart.style.height = `${chartHeight + 2}px`;

    const tooltip = document.createElement('div');
    tooltip.className = 'overview-tooltip hidden';
    chart.append(tooltip);
    const chartState = {
      width: OVERVIEW_CHART_MIN_WIDTH,
      height: chartHeight,
      guide: undefined,
      pointsGroup: undefined
    };

    observeResponsiveSvg(chart, OVERVIEW_CHART_MIN_WIDTH, (width) => {
      const svg = buildOverviewSvg(width, chartHeight, series, trendWindow, chartScale, paddingLeft, paddingRight, paddingTop, paddingBottom);
      chartState.width = width;
      chartState.height = chartHeight;
      chartState.guide = svg.guide;
      chartState.pointsGroup = svg.pointsGroup;
      chart.replaceChildren(svg.element, tooltip);
    });

    chart.addEventListener('pointermove', (event) => {
      if (!chartState.guide || !chartState.pointsGroup) {
        return;
      }

      updateOverviewHover(event, chart, chartState.guide, chartState.pointsGroup, tooltip, series, trendWindow, chartScale, chartState.width, chartState.height, paddingLeft, paddingRight, paddingTop, paddingBottom);
    });
    chart.addEventListener('pointerleave', () => {
      chartState.guide?.classList.add('hidden');
      tooltip.classList.add('hidden');
      chartState.pointsGroup?.replaceChildren();
    });

    return chart;
  }

  function buildOverviewSvg(width, height, series, trendWindow, scale, paddingLeft, paddingRight, paddingTop, paddingBottom) {
    const svg = createSvgElement('svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '直播中主播在线人数总览走势');

    appendTrendAxis(svg, scale, trendWindow, width, height, paddingLeft, paddingRight, paddingTop, paddingBottom, 'overview');

    for (const item of series) {
      const segments = buildTrendSegments(item.points, trendWindow, scale, width, height, paddingLeft, paddingRight, paddingTop, paddingBottom);
      for (const segment of segments) {
        const path = createSvgElement('path');
        path.setAttribute('d', segment);
        path.setAttribute('class', 'overview-trend-line');
        path.classList.toggle('aggregate-trend-line', Boolean(item.aggregate));
        path.style.stroke = item.color;
        svg.append(path);
      }
    }

    const guide = createSvgElement('line');
    guide.setAttribute('class', 'overview-hover-guide hidden');
    guide.setAttribute('y1', String(paddingTop));
    guide.setAttribute('y2', String(height - paddingBottom));
    svg.append(guide);

    const pointsGroup = createSvgElement('g');
    pointsGroup.setAttribute('class', 'overview-hover-points');
    svg.append(pointsGroup);

    return {
      element: svg,
      guide,
      pointsGroup
    };
  }

  function overviewLegend(series, hiddenRoomIds = overviewHiddenRoomIds, onToggle = toggleOverviewSeries) {
    const legend = document.createElement('div');
    legend.className = 'overview-legend';

    const sortedSeries = series
      .map((item, index) => ({ item, index, latestPoint: findLatestValidPoint(item.points) }))
      .sort((left, right) => {
        const leftOnline = left.latestPoint?.[1];
        const rightOnline = right.latestPoint?.[1];
        if (typeof leftOnline !== 'number') {
          return typeof rightOnline === 'number' ? 1 : left.index - right.index;
        }
        if (typeof rightOnline !== 'number') {
          return -1;
        }
        return rightOnline - leftOnline || left.index - right.index;
      });

    for (const { item, latestPoint } of sortedSeries) {
      const hidden = hiddenRoomIds.has(item.room.roomId);
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'overview-legend-item';
      entry.classList.toggle('is-aggregate', Boolean(item.aggregate));
      entry.classList.toggle('is-hidden', hidden);
      entry.title = hidden ? '点击恢复该主播走势' : '点击隐藏该主播走势';
      entry.setAttribute('aria-pressed', String(!hidden));
      entry.addEventListener('click', () => {
        onToggle(item.room.roomId);
      });

      const swatch = document.createElement('span');
      swatch.className = 'overview-legend-swatch';
      swatch.style.background = item.color;

      const name = document.createElement('span');
      name.className = 'overview-legend-name';
      name.textContent = item.room.anchorName || item.room.roomId;

      const value = document.createElement('span');
      value.className = 'overview-legend-value';
      value.textContent = latestPoint ? formatNumber(latestPoint[1]) : '--';

      entry.append(swatch, name, value);
      legend.append(entry);
    }

    return legend;
  }

  function toggleOverviewSeries(roomId) {
    if (overviewHiddenRoomIds.has(roomId)) {
      overviewHiddenRoomIds.delete(roomId);
    } else {
      overviewHiddenRoomIds.add(roomId);
    }
    rerenderLatestSnapshot();
  }

  function pruneOverviewHiddenRoomIds(snapshot) {
    const liveRoomIds = new Set(snapshot.rooms.map((room) => room.roomId));
    for (const scope of overviewAggregateScopes) {
      liveRoomIds.add(getAggregateSeriesId(scope));
    }
    let changed = false;
    for (const roomId of overviewHiddenRoomIds) {
      if (!liveRoomIds.has(roomId)) {
        overviewHiddenRoomIds.delete(roomId);
        changed = true;
      }
    }
    if (changed) {
      persistUiState();
    }
  }

  function updateOverviewHover(event, chart, guide, pointsGroup, tooltip, series, trendWindow, scale, width, height, paddingLeft, paddingRight, paddingTop, paddingBottom) {
    const chartRect = chart.getBoundingClientRect();
    const svgRect = guide.ownerSVGElement?.getBoundingClientRect() || chartRect;
    const pointerX = event.clientX - svgRect.left;
    const renderedWidth = Math.max(1, svgRect.width);
    const viewBoxX = (pointerX / renderedWidth) * width;
    const xRatio = Math.min(1, Math.max(0, (viewBoxX - paddingLeft) / Math.max(1, width - paddingLeft - paddingRight)));
    const x = paddingLeft + xRatio * (width - paddingLeft - paddingRight);
    const timestamp = trendWindow.start + xRatio * (trendWindow.end - trendWindow.start);
    const rows = [];

    pointsGroup.replaceChildren();

    for (const item of series) {
      const nearest = findNearestValidPoint(item.points, timestamp);
      if (!nearest) {
        continue;
      }

      const [, online] = nearest;
      const yRatio = (online - scale.min) / Math.max(1, scale.max - scale.min);
      const y = height - paddingBottom - yRatio * (height - paddingTop - paddingBottom);
      const point = createSvgElement('circle');
      point.setAttribute('cx', formatSvgNumber(x));
      point.setAttribute('cy', formatSvgNumber(y));
      point.setAttribute('r', '3.2');
      point.style.fill = item.color;
      pointsGroup.append(point);

      rows.push({
        color: item.color,
        name: item.room.anchorName || item.room.roomId,
        online
      });
    }

    guide.classList.remove('hidden');
    guide.setAttribute('x1', formatSvgNumber(x));
    guide.setAttribute('x2', formatSvgNumber(x));

    if (rows.length === 0) {
      tooltip.classList.add('hidden');
      return;
    }

    tooltip.replaceChildren();
    const time = document.createElement('div');
    time.className = 'overview-tooltip-time';
    time.textContent = formatTime(timestamp);
    tooltip.append(time);

    for (const row of rows.sort((left, right) => right.online - left.online)) {
      const line = document.createElement('div');
      line.className = 'overview-tooltip-row';

      const dot = document.createElement('span');
      dot.className = 'overview-tooltip-dot';
      dot.style.background = row.color;

      const name = document.createElement('span');
      name.className = 'overview-tooltip-name';
      name.textContent = row.name;

      const value = document.createElement('span');
      value.className = 'overview-tooltip-value';
      value.textContent = formatNumber(row.online);

      line.append(dot, name, value);
      tooltip.append(line);
    }

    const tooltipWidth = 176;
    const chartPointerX = event.clientX - chartRect.left;
    const maxTooltipLeft = Math.max(8, chartRect.width - tooltipWidth - 8);
    const tooltipX =
      chartPointerX > chartRect.width * 0.62
        ? Math.min(maxTooltipLeft, Math.max(8, chartPointerX - tooltipWidth))
        : Math.min(maxTooltipLeft, Math.max(8, chartPointerX + 12));
    tooltip.style.left = `${tooltipX}px`;
    tooltip.style.top = '12px';
    tooltip.classList.remove('hidden');
  }

  function appendTrendAxis(svg, scale, trendWindow, width, height, paddingLeft, paddingRight, paddingTop, paddingBottom, prefix) {
    const plotLeft = paddingLeft;
    const plotRight = width - paddingRight;
    const plotTop = paddingTop;
    const plotBottom = height - paddingBottom;

    const plotWidth = Math.max(1, plotRight - plotLeft);
    const plotHeight = Math.max(1, plotBottom - plotTop);
    const yTicks = buildAdaptiveNumberTicks(scale, plotHeight);
    const xTicks = buildAdaptiveTimeTicks(trendWindow, plotWidth);

    for (const value of yTicks) {
      const ratio = (value - scale.min) / Math.max(1, scale.max - scale.min);
      const y = plotBottom - ratio * plotHeight;
      const grid = createSvgElement('line');
      grid.setAttribute('x1', String(plotLeft));
      grid.setAttribute('x2', String(plotRight));
      grid.setAttribute('y1', formatSvgNumber(y));
      grid.setAttribute('y2', formatSvgNumber(y));
      grid.setAttribute('class', `${prefix}-grid-line`);
      svg.append(grid, svgText(formatNumber(value), plotLeft - 6, y + 4, `${prefix}-axis-text`, 'end'));
    }

    for (const timestamp of xTicks) {
      const ratio = (timestamp - trendWindow.start) / Math.max(1, trendWindow.end - trendWindow.start);
      const x = plotLeft + ratio * plotWidth;
      const grid = createSvgElement('line');
      grid.setAttribute('x1', formatSvgNumber(x));
      grid.setAttribute('x2', formatSvgNumber(x));
      grid.setAttribute('y1', String(plotTop));
      grid.setAttribute('y2', String(plotBottom));
      grid.setAttribute('class', `${prefix}-grid-line`);
      const anchor = timestamp === trendWindow.start ? 'start' : timestamp === trendWindow.end ? 'end' : 'middle';
      svg.append(grid, svgText(formatShortTime(timestamp), x, height - 6, `${prefix}-axis-text`, anchor));
    }

    const yAxis = createSvgElement('line');
    yAxis.setAttribute('x1', String(plotLeft));
    yAxis.setAttribute('x2', String(plotLeft));
    yAxis.setAttribute('y1', String(plotTop));
    yAxis.setAttribute('y2', String(plotBottom));
    yAxis.setAttribute('class', `${prefix}-axis-line`);

    const xAxis = createSvgElement('line');
    xAxis.setAttribute('x1', String(plotLeft));
    xAxis.setAttribute('x2', String(plotRight));
    xAxis.setAttribute('y1', String(plotBottom));
    xAxis.setAttribute('y2', String(plotBottom));
    xAxis.setAttribute('class', `${prefix}-axis-line`);

    svg.append(yAxis, xAxis);
  }

  function getAggregateChartScale(scale) {
    if (scale.min >= 0 && scale.max > 0) {
      return { min: 0, max: scale.max };
    }
    return scale;
  }

  function buildAdaptiveNumberTicks(scale, plotHeight) {
    const range = scale.max - scale.min;
    if (!Number.isFinite(range) || range <= 0) {
      return [scale.min, scale.max];
    }

    const targetIntervals = Math.max(2, Math.min(10, Math.floor(plotHeight / 58)));
    const step = getNiceAxisStep(range / targetIntervals);
    const ticks = [scale.min];
    const firstTick = Math.ceil(scale.min / step) * step;
    for (let value = firstTick; value < scale.max; value += step) {
      const normalized = Number(value.toPrecision(12));
      if (normalized > scale.min && normalized < scale.max) {
        ticks.push(normalized);
      }
    }
    ticks.push(scale.max);
    return filterAxisTicksBySpacing(ticks, scale.min, scale.max, plotHeight, 34);
  }

  function getNiceAxisStep(rawStep) {
    if (!Number.isFinite(rawStep) || rawStep <= 0) {
      return 1;
    }

    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const normalized = rawStep / magnitude;
    const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return multiplier * magnitude;
  }

  function buildAdaptiveTimeTicks(trendWindow, plotWidth) {
    const duration = Math.max(1, trendWindow.end - trendWindow.start);
    const targetIntervals = Math.max(2, Math.min(12, Math.floor(plotWidth / 96)));
    const stepCandidates = [
      60_000,
      2 * 60_000,
      5 * 60_000,
      10 * 60_000,
      15 * 60_000,
      30 * 60_000,
      60 * 60_000,
      2 * 60 * 60_000,
      3 * 60 * 60_000,
      6 * 60 * 60_000,
      12 * 60 * 60_000,
      24 * 60 * 60_000
    ];
    const step = stepCandidates.find((candidate) => duration / candidate <= targetIntervals)
      || stepCandidates[stepCandidates.length - 1];
    const ticks = [trendWindow.start];
    const firstTick = Math.ceil(trendWindow.start / step) * step;
    for (let timestamp = firstTick; timestamp < trendWindow.end; timestamp += step) {
      if (timestamp > trendWindow.start) {
        ticks.push(timestamp);
      }
    }
    ticks.push(trendWindow.end);
    return filterAxisTicksBySpacing(ticks, trendWindow.start, trendWindow.end, plotWidth, 72);
  }

  function filterAxisTicksBySpacing(ticks, min, max, pixelSize, minSpacing) {
    const uniqueTicks = Array.from(new Set(ticks)).sort((left, right) => left - right);
    if (uniqueTicks.length <= 2 || max <= min) {
      return uniqueTicks;
    }

    const result = [uniqueTicks[0]];
    const lastTick = uniqueTicks[uniqueTicks.length - 1];
    for (const tick of uniqueTicks.slice(1, -1)) {
      const previous = result[result.length - 1];
      const previousDistance = ((tick - previous) / (max - min)) * pixelSize;
      const endDistance = ((lastTick - tick) / (max - min)) * pixelSize;
      if (previousDistance >= minSpacing && endDistance >= minSpacing) {
        result.push(tick);
      }
    }
    result.push(lastTick);
    return result;
  }

  function svgText(text, x, y, className, anchor) {
    const element = createSvgElement('text');
    element.setAttribute('x', formatSvgNumber(x));
    element.setAttribute('y', formatSvgNumber(y));
    element.setAttribute('class', className);
    element.setAttribute('text-anchor', anchor);
    element.textContent = text;
    return element;
  }

  function findNearestValidPoint(points, timestamp) {
    let nearest = undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const point of points) {
      const [pointTimestamp, online] = point;
      if (typeof online !== 'number') {
        continue;
      }

      const distance = Math.abs(pointTimestamp - timestamp);
      if (distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }

    return nearest;
  }

  function findLatestValidPoint(points) {
    let latest = undefined;
    for (const point of points || []) {
      const [timestamp, online] = point;
      if (typeof online === 'number' && (!latest || timestamp > latest[0])) {
        latest = point;
      }
    }
    return latest;
  }

  function textSpan(text) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
  }

  function updateTrendControls(snapshot) {
    trendWindowRange.min = String(TREND_WINDOW_MIN_MINUTES);
    trendWindowRange.max = String(TREND_WINDOW_MAX_MINUTES);
    trendWindowRange.step = '1';
    trendWindowRange.value = String(trendWindowMinutes);
    trendToggle.classList.toggle('active', trendsExpanded);
    trendToggle.setAttribute('aria-pressed', String(trendsExpanded));
    overviewTrendToggle.classList.remove('active');
    historyTrendToggle.classList.remove('active');
    trendWindowLabel.textContent = formatTrendWindowLabel(getTrendWindow(snapshot));
  }

  function updateDisplayModeControl() {
    displayModeToggle.textContent = displayMode === 'detail' ? '简略' : '详细';
    displayModeToggle.title = displayMode === 'detail' ? '切换为简略模式' : '切换为详细模式';
    displayModeToggle.classList.toggle('active', displayMode === 'compact');
  }

  function updateControlPanelState() {
    controlPanel.classList.toggle('collapsed', !controlPanelExpanded);
    controlPanel.setAttribute('aria-hidden', String(!controlPanelExpanded));
    controlPanelToggle.setAttribute('aria-expanded', String(controlPanelExpanded));
    controlPanelToggle.textContent = controlPanelExpanded ? '⌃' : '⋯';
    controlPanelToggle.title = controlPanelExpanded ? '收起控制面板' : '展开控制面板';
    controlPanelToggle.setAttribute('aria-label', controlPanelExpanded ? '收起控制面板' : '展开控制面板');
  }

  function updateSortFilterControls() {
    sortFieldSelect.value = sortField;
    sortDirectionToggle.textContent = sortDirection === 'desc' ? '大到小' : '小到大';
    sortDirectionToggle.title = sortDirection === 'desc' ? '当前大到小，点击切换为小到大' : '当前小到大，点击切换为大到小';
    filterAllButton.classList.toggle('active', statusFilter === 'all');
    filterLiveButton.classList.toggle('active', statusFilter === 'live');
    filterOfflineButton.classList.toggle('active', statusFilter === 'offline');
  }

  function getGroupDropTargetIndex(groups, draggedGroupId, hoveredIndex, insertAfter) {
    const fromIndex = groups.findIndex((item) => item.id === draggedGroupId);
    if (fromIndex < 0 || groups.length === 0) {
      return -1;
    }

    let targetIndex = hoveredIndex + (insertAfter ? 1 : 0);
    if (fromIndex < targetIndex) {
      targetIndex -= 1;
    }
    return Math.max(0, Math.min(groups.length - 1, targetIndex));
  }

  function updateGroupControls(snapshot) {
    groupManager.replaceChildren();
    const groups = getCustomGroups(snapshot);
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'group-manager-empty';
      empty.textContent = '暂无自定义分组';
      groupManager.append(empty);
      return;
    }

    let draggedGroupId = '';
    const clearDragState = () => {
      draggedGroupId = '';
      groupManager.querySelectorAll('.group-manager-row').forEach((item) => {
        item.classList.remove('dragging', 'drag-over-before', 'drag-over-after');
      });
    };

    for (const [index, group] of groups.entries()) {
      const row = document.createElement('div');
      row.className = 'group-manager-row';
      row.dataset.groupId = group.id;

      const primary = document.createElement('div');
      primary.className = 'group-manager-primary';

      const name = document.createElement('span');
      name.className = 'group-manager-name';
      name.textContent = group.name;
      name.title = group.name;

      const count = document.createElement('span');
      count.className = 'group-manager-count';
      count.textContent = String((group.rooms || []).length);
      count.title = '分组内监控房间数';
      primary.append(name, count);

      const actions = document.createElement('div');
      actions.className = 'group-manager-actions';

      const dragHandle = document.createElement('span');
      dragHandle.className = 'group-drag-handle';
      dragHandle.textContent = '≡';
      dragHandle.title = `拖动分组“${group.name}”调整顺序`;
      dragHandle.setAttribute('aria-label', dragHandle.title);
      dragHandle.setAttribute('role', 'img');
      dragHandle.draggable = true;
      dragHandle.addEventListener('dragstart', (event) => {
        draggedGroupId = group.id;
        row.classList.add('dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', group.id);
          event.dataTransfer.setDragImage(row, 12, Math.floor(row.offsetHeight / 2));
        }
      });
      dragHandle.addEventListener('dragend', clearDragState);

      row.addEventListener('dragover', (event) => {
        if (!draggedGroupId || draggedGroupId === group.id) {
          return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'move';
        }
        groupManager.querySelectorAll('.group-manager-row').forEach((item) => {
          item.classList.remove('drag-over-before', 'drag-over-after');
        });
        const position = event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2 ? 'before' : 'after';
        row.classList.add(position === 'before' ? 'drag-over-before' : 'drag-over-after');
      });
      row.addEventListener('drop', (event) => {
        if (!draggedGroupId || draggedGroupId === group.id) {
          clearDragState();
          return;
        }
        event.preventDefault();
        const insertAfter = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
        const fromIndex = groups.findIndex((item) => item.id === draggedGroupId);
        const targetIndex = getGroupDropTargetIndex(groups, draggedGroupId, index, insertAfter);
        if (targetIndex >= 0 && fromIndex !== targetIndex) {
          vscode.postMessage({ type: 'moveGroupToIndex', groupId: draggedGroupId, targetIndex });
        }
        clearDragState();
      });

      const moveButtons = document.createElement('div');
      moveButtons.className = 'group-move-buttons';
      const moveUpButton = buildGroupMoveButton(group, 'up', '↑', index === 0);
      const moveDownButton = buildGroupMoveButton(group, 'down', '↓', index === groups.length - 1);
      moveButtons.append(moveUpButton, moveDownButton);

      const renameButton = document.createElement('button');
      renameButton.type = 'button';
      renameButton.className = 'group-rename-button ghost-button';
      renameButton.textContent = '✎';
      renameButton.title = `修改分组“${group.name}”的名称`;
      renameButton.setAttribute('aria-label', renameButton.title);
      renameButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'renameGroup', groupId: group.id });
      });

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'group-delete-button ghost-button';
      deleteButton.textContent = '删除';
      deleteButton.title = `删除分组“${group.name}”`;
      deleteButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'deleteGroup', groupId: group.id });
      });

      actions.append(dragHandle, moveButtons, renameButton, deleteButton);
      row.append(primary, actions);
      groupManager.append(row);
    }
  }

  function buildGroupMoveButton(group, direction, icon, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'group-move-button ghost-button';
    button.textContent = icon;
    button.disabled = disabled;
    const action = direction === 'up' ? '上移' : '下移';
    button.title = `${action}分组“${group.name}”`;
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'moveGroup', groupId: group.id, direction });
    });
    return button;
  }

  function ensureTrendScopes(snapshot) {
    const validGroupScopes = new Set(getCustomGroups(snapshot).map((group) => getGroupScope(group.id)));
    pruneInvalidRangeScopes(overviewRangeScopes, validGroupScopes);
    pruneInvalidRangeScopes(historyRangeScopes, validGroupScopes);
    pruneInvalidAggregateScopes(overviewAggregateScopes, overviewHiddenRoomIds, validGroupScopes);
    pruneInvalidAggregateScopes(historyAggregateScopes, historyHiddenRoomIds, validGroupScopes);
  }

  function pruneInvalidRangeScopes(scopes, validGroupScopes) {
    for (const scope of scopes) {
      if (isGroupScope(scope) && !validGroupScopes.has(scope)) {
        scopes.delete(scope);
      }
    }
  }

  function pruneInvalidAggregateScopes(scopes, hiddenRoomIds, validGroupScopes) {
    for (const scope of scopes) {
      if (isGroupScope(scope) && !validGroupScopes.has(scope)) {
        scopes.delete(scope);
        hiddenRoomIds.delete(getAggregateSeriesId(scope));
      }
    }
  }

  function persistUiState() {
    vscode.setState({
      roomListExpanded,
      controlPanelExpanded,
      displayMode,
      sortField,
      sortDirection,
      statusFilter,
      trendsExpanded,
      trendWindowMinutes,
      overviewTrendExpanded,
      overviewTrendWindowMinutes,
      overviewTrendHeight,
      overviewRangeScopes: Array.from(overviewRangeScopes),
      overviewAggregateScopes: Array.from(overviewAggregateScopes),
      overviewHiddenRoomIds: Array.from(overviewHiddenRoomIds),
      collapsedGroupKeys: Array.from(collapsedGroupKeys),
      openRoomGroupEditors: Array.from(openRoomGroupEditors),
      historyTrendExpanded,
      historySelectedDate,
      historyStartMinute,
      historyEndMinute,
      historyTrendHeight,
      historyRangeScopes: Array.from(historyRangeScopes),
      historyAggregateScopes: Array.from(historyAggregateScopes),
      historyHiddenRoomIds: Array.from(historyHiddenRoomIds)
    });
  }

  function normalizePersistedState(state) {
    const safeState = state && typeof state === 'object' ? state : {};
    return {
      roomListExpanded: safeState.roomListExpanded !== false,
      controlPanelExpanded: Boolean(safeState.controlPanelExpanded),
      displayMode: ['detail', 'compact'].includes(safeState.displayMode) ? safeState.displayMode : 'detail',
      sortField: ['default', 'live', 'online', 'guard', 'fans', 'duration'].includes(safeState.sortField)
        ? safeState.sortField
        : 'default',
      sortDirection: ['desc', 'asc'].includes(safeState.sortDirection) ? safeState.sortDirection : 'desc',
      statusFilter: ['all', 'live', 'offline'].includes(safeState.statusFilter) ? safeState.statusFilter : 'all',
      trendsExpanded: Boolean(safeState.trendsExpanded),
      trendWindowMinutes: clampTrendWindowMinutes(Number(safeState.trendWindowMinutes)),
      overviewTrendExpanded: Boolean(safeState.overviewTrendExpanded),
      overviewTrendWindowMinutes: clampTrendWindowMinutes(Number(safeState.overviewTrendWindowMinutes)),
      overviewTrendHeight: clampAggregateChartHeight(Number(safeState.overviewTrendHeight)),
      overviewRangeScopes: normalizePersistedRangeScopes(
        safeState.overviewRangeScopes,
        safeState.overviewRangeMode,
        OVERVIEW_RANGE_MODES
      ),
      overviewAggregateScopes: normalizePersistedAggregateScopes(
        safeState.overviewAggregateScopes,
        safeState.overviewAggregateEnabled ? safeState.overviewRangeMode : undefined,
        OVERVIEW_RANGE_MODES
      ),
      overviewHiddenRoomIds: Array.isArray(safeState.overviewHiddenRoomIds)
        ? safeState.overviewHiddenRoomIds.filter((roomId) => typeof roomId === 'string')
        : [],
      collapsedGroupKeys: Array.isArray(safeState.collapsedGroupKeys)
        ? safeState.collapsedGroupKeys.filter((key) => typeof key === 'string')
        : [],
      openRoomGroupEditors: Array.isArray(safeState.openRoomGroupEditors)
        ? safeState.openRoomGroupEditors.filter((roomId) => typeof roomId === 'string')
        : [],
      historyTrendExpanded: Boolean(safeState.historyTrendExpanded),
      historySelectedDate: typeof safeState.historySelectedDate === 'string' ? safeState.historySelectedDate : '',
      ...normalizePersistedHistoryRange(safeState),
      historyTrendHeight: clampAggregateChartHeight(Number(safeState.historyTrendHeight)),
      historyRangeScopes: normalizePersistedRangeScopes(
        safeState.historyRangeScopes,
        safeState.historyRangeMode,
        HISTORY_RANGE_MODES
      ),
      historyAggregateScopes: normalizePersistedAggregateScopes(
        safeState.historyAggregateScopes,
        safeState.historyAggregateEnabled ? safeState.historyRangeMode : undefined,
        HISTORY_RANGE_MODES
      ),
      historyHiddenRoomIds: Array.isArray(safeState.historyHiddenRoomIds)
        ? safeState.historyHiddenRoomIds.filter((roomId) => typeof roomId === 'string')
        : []
    };
  }

  function normalizePersistedAggregateScopes(scopes, legacyScope, builtInScopes) {
    const candidates = Array.isArray(scopes) ? scopes : legacyScope ? [legacyScope] : [];
    return candidates.filter((scope, index) =>
      typeof scope === 'string'
      && isValidPersistedScope(scope, builtInScopes)
      && candidates.indexOf(scope) === index
    );
  }

  function normalizePersistedRangeScopes(scopes, legacyScope, builtInScopes) {
    const hasPersistedScopes = Array.isArray(scopes);
    const candidates = hasPersistedScopes ? scopes : legacyScope ? [legacyScope] : ['all'];
    return candidates.filter((scope, index) =>
      typeof scope === 'string'
      && isValidPersistedScope(scope, builtInScopes)
      && candidates.indexOf(scope) === index
    );
  }

  function normalizePersistedHistoryRange(safeState) {
    const normalized = normalizeHistoryMinuteRange(Number(safeState.historyStartMinute), Number(safeState.historyEndMinute));
    return {
      historyStartMinute: normalized.start,
      historyEndMinute: normalized.end
    };
  }

  function isValidPersistedScope(scope, baseModes) {
    return typeof scope === 'string' && (baseModes.includes(scope) || isGroupScope(scope));
  }

  function getCustomGroups(snapshot = latestSnapshot) {
    const rooms = new Set((snapshot?.settings?.rooms || []).map((roomId) => String(roomId)));
    const seenIds = new Set();
    const groups = [];
    for (const group of snapshot?.settings?.groups || []) {
      const id = String(group?.id ?? '').trim();
      const name = String(group?.name ?? '').trim();
      if (!id || !name || seenIds.has(id)) {
        continue;
      }

      seenIds.add(id);
      groups.push({
        id,
        name,
        rooms: normalizeRoomIdList(group.rooms).filter((roomId) => rooms.size === 0 || rooms.has(roomId))
      });
    }

    return groups;
  }

  function normalizeRoomIdList(values) {
    if (!Array.isArray(values)) {
      return [];
    }

    const seen = new Set();
    const result = [];
    for (const value of values) {
      const roomId = String(value ?? '').trim();
      if (!/^\d+$/.test(roomId) || seen.has(roomId)) {
        continue;
      }

      seen.add(roomId);
      result.push(roomId);
    }

    return result;
  }

  function getGroupKey(groupId) {
    return `custom:${groupId}`;
  }

  function getGroupScope(groupId) {
    return `${GROUP_SCOPE_PREFIX}${groupId}`;
  }

  function isGroupScope(scope) {
    return typeof scope === 'string' && scope.startsWith(GROUP_SCOPE_PREFIX) && scope.length > GROUP_SCOPE_PREFIX.length;
  }

  function getGroupIdFromScope(scope) {
    return isGroupScope(scope) ? scope.slice(GROUP_SCOPE_PREFIX.length) : '';
  }

  function getGroupRoomIdSet(scope, snapshot = latestSnapshot) {
    const groupId = getGroupIdFromScope(scope);
    if (!groupId) {
      return undefined;
    }

    const group = getCustomGroups(snapshot).find((item) => item.id === groupId);
    return group ? new Set(group.rooms || []) : new Set();
  }

  function getVisibleRooms(snapshot) {
    return snapshot.rooms
      .map((room, index) => ({ room, index }))
      .filter(({ room }) => matchesStatusFilter(room))
      .sort(compareRoomEntries)
      .map(({ room }) => room);
  }

  function matchesStatusFilter(room) {
    if (statusFilter === 'live') {
      return room.status === 'live';
    }
    if (statusFilter === 'offline') {
      return room.status !== 'live';
    }
    return true;
  }

  function compareRoomEntries(left, right) {
    if (sortField === 'default') {
      return left.index - right.index;
    }

    const leftValue = getSortValue(left.room);
    const rightValue = getSortValue(right.room);
    const leftMissing = leftValue === null || leftValue === undefined || Number.isNaN(leftValue);
    const rightMissing = rightValue === null || rightValue === undefined || Number.isNaN(rightValue);

    if (leftMissing !== rightMissing) {
      return leftMissing ? 1 : -1;
    }
    if (leftMissing && rightMissing) {
      return left.index - right.index;
    }
    if (leftValue === rightValue) {
      return left.index - right.index;
    }

    const direction = sortDirection === 'desc' ? -1 : 1;
    return leftValue > rightValue ? direction : -direction;
  }

  function getSortValue(room) {
    if (sortField === 'live') {
      return room.status === 'live' ? 1 : 0;
    }
    if (sortField === 'online') {
      return typeof room.online === 'number' ? room.online : null;
    }
    if (sortField === 'guard') {
      return typeof room.guardFleet?.total === 'number' ? room.guardFleet.total : null;
    }
    if (sortField === 'fans') {
      return typeof room.fansCount === 'number' ? room.fansCount : null;
    }
    if (sortField === 'duration') {
      return getDurationSeconds(room, latestSnapshot);
    }
    return null;
  }

  function getRefreshState(snapshot) {
    if (snapshot.loading) {
      return { kind: 'updating', text: '更新中' };
    }

    if (!snapshot.lastRefreshAt) {
      return { kind: 'pending', text: '未刷新' };
    }

    const failedCount = snapshot.rooms.filter((room) => Boolean(room.error)).length;
    if (failedCount === 0) {
      return { kind: 'ok', text: '刷新成功' };
    }

    if (failedCount === snapshot.rooms.length) {
      return { kind: 'failed', text: '刷新失败' };
    }

    return { kind: 'warning', text: `部分失败 ${failedCount}` };
  }

  function liveDotClass(status) {
    return status === 'live' ? 'live' : 'offline';
  }

  function liveDotTitle(status) {
    if (status === 'live') {
      return '直播中';
    }
    if (status === 'offline') {
      return '未开播';
    }
    return '状态未知';
  }

  function getTrendWindow(snapshot) {
    const now = snapshot.lastRefreshAt || Date.now();
    const end = now;
    const start = now - trendWindowMinutes * 60 * 1000;
    return {
      start,
      end,
      windowMinutes: trendWindowMinutes
    };
  }

  function getOverviewTrendWindow(snapshot) {
    const now = snapshot.lastRefreshAt || Date.now();
    const end = now;
    const start = now - overviewTrendWindowMinutes * 60 * 1000;
    return {
      start,
      end,
      windowMinutes: overviewTrendWindowMinutes
    };
  }

  function formatTrendWindowLabel(trendWindow) {
    return formatTrendWindowMinutesLabel(trendWindow.windowMinutes);
  }

  function formatTrendWindowMinutesLabel(minutes) {
    return `最近 ${formatWindowMinutes(minutes)}`;
  }

  function formatWindowMinutes(minutes) {
    if (minutes < 60) {
      return `${minutes} 分钟`;
    }

    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return remainMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${remainMinutes} 分钟`;
  }

  function clampTrendWindowMinutes(value) {
    if (!Number.isFinite(value)) {
      return TREND_WINDOW_DEFAULT_MINUTES;
    }
    return Math.min(TREND_WINDOW_MAX_MINUTES, Math.max(TREND_WINDOW_MIN_MINUTES, Math.floor(value)));
  }

  function clampAggregateChartHeight(value) {
    if (!Number.isFinite(value)) {
      return AGGREGATE_CHART_DEFAULT_HEIGHT;
    }
    return Math.min(AGGREGATE_CHART_MAX_HEIGHT, Math.max(AGGREGATE_CHART_MIN_HEIGHT, Math.round(value)));
  }

  function clampHistoryMinute(value, fallback) {
    if (!Number.isFinite(value)) {
      return fallback;
    }

    return Math.min(23 * 60 + 59, Math.max(0, Math.floor(value)));
  }

  function formatMinuteInput(minute) {
    const normalizedMinute = clampHistoryMinute(minute, 0);
    const hours = Math.floor(normalizedMinute / 60);
    const minutes = normalizedMinute % 60;
    return `${padClockPart(hours)}:${padClockPart(minutes)}`;
  }

  function getScaleForPoints(points) {
    let count = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const [, online] of points) {
      if (typeof online !== 'number') {
        continue;
      }

      count += 1;
      min = Math.min(min, online);
      max = Math.max(max, online);
    }

    if (count < 2) {
      return undefined;
    }

    if (min === max) {
      const padding = Math.max(1, Math.ceil(max * 0.05));
      min = Math.max(0, min - padding);
      max += padding;
    }
    return { min, max };
  }

  function createSvgElement(tagName) {
    return document.createElementNS('http://www.w3.org/2000/svg', tagName);
  }

  function formatSvgNumber(value) {
    return Number(value).toFixed(2);
  }

  function actionButton(text, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = title;
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  function metricLabel(label) {
    const labelElement = document.createElement('div');
    labelElement.className = 'compact-label';
    labelElement.textContent = label;
    return labelElement;
  }

  function metricValue(value) {
    const valueElement = document.createElement('div');
    valueElement.className = 'compact-value';
    valueElement.textContent = value;
    return valueElement;
  }

  function applyCachedMetricState(element, stale, lastSuccessAt, label) {
    if (!stale) {
      return;
    }

    element.classList.add('metric-stale');
    const lastSuccessText = lastSuccessAt ? formatTime(lastSuccessAt) : '未知时间';
    element.title = `${label}本轮获取失败，正在显示上次成功数据（${lastSuccessText}）`;
    element.setAttribute('aria-label', `${label}，本轮获取失败，显示上次成功数据（${lastSuccessText}）`);
  }

  function durationValue(room) {
    const valueElement = metricValue('');
    valueElement.classList.add('duration-value');
    bindDurationValue(valueElement, room);
    return valueElement;
  }

  function statusText(status) {
    if (status === 'live') {
      return '直播中';
    }
    if (status === 'offline') {
      return '未开播';
    }
    return '未知';
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(value);
  }

  function formatNullableNumber(value) {
    return typeof value === 'number' ? formatNumber(value) : '-';
  }

  function formatTime(timestamp) {
    if (!timestamp) {
      return '-';
    }
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  }

  function formatShortTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  function formatHistoryDateLabel(dateText) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
    if (!match) {
      return dateText;
    }

    return `${Number(match[2])}/${Number(match[3])}`;
  }

  function formatDurationClock(room, snapshot) {
    const elapsedSeconds = getDurationSeconds(room, snapshot);
    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    const seconds = elapsedSeconds % 60;
    return `${padClockPart(hours)}:${padClockPart(minutes)}:${padClockPart(seconds)}`;
  }

  function getDurationSeconds(room, snapshot) {
    if (room.status !== 'live' || !room.liveStartTime) {
      return 0;
    }

    const nowMs = snapshot?.lastRefreshAt || Date.now();
    return Math.max(0, Math.floor(nowMs / 1000) - room.liveStartTime);
  }

  function padClockPart(value) {
    return String(value).padStart(2, '0');
  }

  function bindDurationValue(element, room) {
    if (room.status === 'live' && room.liveStartTime) {
      element.dataset.liveStartTime = String(room.liveStartTime);
    } else {
      delete element.dataset.liveStartTime;
    }
    element.textContent = formatDurationClock(room, { lastRefreshAt: Date.now() });
  }

  function updateDurationDisplays() {
    const elements = document.querySelectorAll('.duration-value');
    for (const element of elements) {
      const liveStartTime = Number(element.dataset.liveStartTime);
      if (!Number.isFinite(liveStartTime) || liveStartTime <= 0) {
        element.textContent = '00:00:00';
        continue;
      }

      element.textContent = formatDurationClock(
        {
          status: 'live',
          liveStartTime
        },
        { lastRefreshAt: Date.now() }
      );
    }
  }

  function formatGuardFleet(guardFleet) {
    if (!guardFleet) {
      return '-';
    }

    return formatNumber(guardFleet.total);
  }
})();
