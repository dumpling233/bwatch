(function () {
  const vscode = acquireVsCodeApi();
  const savedState = vscode.getState() || {};
  const MAX_MESSAGES = 500;
  const MAX_SUPER_CHATS = 100;
  const RENDER_DIAGNOSTIC_INTERVAL_MS = 10_000;
  const DEFAULT_DISPLAY_OPTIONS = Object.freeze({
    showTime: true,
    showUsername: true,
    showUid: false,
    showMedal: true,
    showAdmin: false,
    showColorBar: true,
    showEmoji: true
  });
  const EMOJI_TEXT_ALIASES = Object.freeze({
    '👍': '点赞',
    '👎': '点踩',
    '😂': '笑哭',
    '🤣': '大笑',
    '😀': '开心',
    '😊': '微笑',
    '😭': '大哭',
    '😢': '难过',
    '😡': '生气',
    '🤢': '恶心',
    '❤': '爱心',
    '🔥': '火',
    '🎉': '庆祝',
    '👏': '鼓掌',
    '🙏': '感谢',
    '💪': '加油',
    '👀': '围观',
    '🤔': '思考',
    '😅': '尴尬',
    '😍': '喜欢',
    '😎': '酷',
    '💯': '满分',
    '🚀': '火箭',
    '🌹': '玫瑰',
    '🎂': '生日蛋糕',
    '🤡': '小丑',
    '👩‍💻': '女性程序员',
    '👨‍💻': '男性程序员',
    '🇨🇳': '中国国旗',
    '1⃣': '数字 1'
  });
  const EMOJI_PATTERN = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)/gu;
  const form = document.getElementById('connection-form');
  const roomSelect = document.getElementById('room-select');
  const roomInput = document.getElementById('room-input');
  const connectButton = document.getElementById('connect-button');
  const disconnectButton = document.getElementById('disconnect-button');
  const openRoomButton = document.getElementById('open-room-button');
  const clearButton = document.getElementById('clear-button');
  const autoScrollToggle = document.getElementById('auto-scroll-toggle');
  const displaySettingsButton = document.getElementById('display-settings-button');
  const displaySettingsPanel = document.getElementById('display-settings-panel');
  const displayOptionInputs = Array.from(document.querySelectorAll('[data-display-option]'));
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const popularity = document.getElementById('popularity');
  const roomInfo = document.getElementById('room-info');
  const roomLiveDot = document.getElementById('room-live-dot');
  const roomAnchorName = document.getElementById('room-anchor-name');
  const roomLiveState = document.getElementById('room-live-state');
  const roomTitle = document.getElementById('room-title');
  const roomOnline = document.getElementById('room-online');
  const roomDuration = document.getElementById('room-duration');
  const roomGuards = document.getElementById('room-guards');
  const roomFans = document.getElementById('room-fans');
  const danmakuTab = document.getElementById('danmaku-tab');
  const superChatTab = document.getElementById('super-chat-tab');
  const messageCount = document.getElementById('message-count');
  const superChatCount = document.getElementById('super-chat-count');
  const messagesElement = document.getElementById('messages');
  const superChatsElement = document.getElementById('super-chats');
  const emptyState = document.getElementById('empty-state');
  const superChatEmptyState = document.getElementById('super-chat-empty-state');
  let currentRoomId = '';
  let requestedRoomId = '';
  let sessionStatus = 'idle';
  let monitoredRooms = [];
  let messages = [];
  let superChats = [];
  let activeMessageView = savedState.activeMessageView === 'superChat' ? 'superChat' : 'danmaku';
  let displayOptions = normalizeDisplayOptions(savedState.displayOptions);
  let displaySettingsExpanded = savedState.displaySettingsExpanded === true;
  let renderDiagnostics = createRenderDiagnostics(Date.now());
  let expectedRenderDiagnosticAt = Date.now() + RENDER_DIAGNOSTIC_INTERVAL_MS;

  autoScrollToggle.checked = savedState.autoScroll !== false;
  syncDisplaySettingsControls();
  syncMessageView();
  postEmojiDisplaySetting();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const roomId = String(roomInput.value || roomSelect.value || '').trim();
    if (!/^\d+$/.test(roomId)) {
      roomInput.focus();
      return;
    }
    savedState.selectedRoomId = roomId;
    vscode.setState(savedState);
    vscode.postMessage({ type: 'connect', roomId });
  });

  disconnectButton.addEventListener('click', () => vscode.postMessage({ type: 'disconnect' }));
  clearButton.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  danmakuTab.addEventListener('click', () => selectMessageView('danmaku'));
  superChatTab.addEventListener('click', () => selectMessageView('superChat'));
  openRoomButton.addEventListener('click', () => {
    if (currentRoomId) {
      vscode.postMessage({ type: 'openRoom', roomId: currentRoomId });
    }
  });
  roomSelect.addEventListener('change', () => {
    savedState.selectedRoomId = roomSelect.value;
    vscode.setState(savedState);
    renderRoomInfo(roomSelect.value);
  });
  roomInput.addEventListener('input', () => {
    const roomId = String(roomInput.value || '').trim();
    if (/^\d+$/.test(roomId)) {
      renderRoomInfo(roomId);
    } else if (!roomId) {
      renderRoomInfo(currentRoomId || roomSelect.value);
    }
  });
  autoScrollToggle.addEventListener('change', () => {
    savedState.autoScroll = autoScrollToggle.checked;
    vscode.setState(savedState);
    if (autoScrollToggle.checked) {
      scrollToBottom();
    }
  });
  displaySettingsButton.addEventListener('click', () => {
    displaySettingsExpanded = !displaySettingsExpanded;
    persistDisplaySettings();
    syncDisplaySettingsControls();
  });
  for (const input of displayOptionInputs) {
    input.addEventListener('change', () => {
      const key = input.dataset.displayOption;
      if (!key || !Object.prototype.hasOwnProperty.call(DEFAULT_DISPLAY_OPTIONS, key)) {
        return;
      }
      displayOptions = { ...displayOptions, [key]: input.checked };
      persistDisplaySettings();
      renderAllMessages();
      renderAllSuperChats();
      if (key === 'showEmoji') {
        postEmojiDisplaySetting();
      }
    });
  }

  window.addEventListener('message', (event) => {
    const payload = event.data || {};
    if (payload.type === 'rooms') {
      renderRoomOptions(Array.isArray(payload.rooms) ? payload.rooms : []);
      return;
    }
    if (payload.type === 'selectRoom') {
      selectRoom(String(payload.roomId || ''));
      return;
    }
    if (payload.type === 'snapshot') {
      renderSnapshot(payload.snapshot || {});
      return;
    }
    if (payload.type === 'message' && payload.message) {
      appendMessage(payload.message);
      return;
    }
    if (payload.type === 'messageBatch' && Array.isArray(payload.messages)) {
      const renderStartedAt = performance.now();
      appendMessages(payload.messages);
      observeRenderBatch(payload, performance.now() - renderStartedAt);
      return;
    }
    if (payload.type === 'superChat' && payload.superChat) {
      appendSuperChat(payload.superChat);
      return;
    }
    if (payload.type === 'superChatDelete' && Array.isArray(payload.ids)) {
      removeSuperChats(payload.ids);
      return;
    }
    if (payload.type === 'clear') {
      clearMessages();
    }
  });

  function renderRoomOptions(rooms) {
    monitoredRooms = rooms;
    const previous = savedState.selectedRoomId || roomSelect.value;
    roomSelect.replaceChildren();
    if (rooms.length === 0) {
      roomSelect.appendChild(createOption('', '暂无监控房间'));
      roomSelect.disabled = true;
      renderRoomInfo(requestedRoomId || currentRoomId || previous);
      return;
    }
    roomSelect.disabled = false;
    for (const room of rooms) {
      const liveMark = room.isLive ? '🟢' : '🔴';
      roomSelect.appendChild(createOption(room.roomId, `${liveMark} ${room.anchorName} · ${room.roomId}`));
    }
    if (rooms.some((room) => room.roomId === previous)) {
      roomSelect.value = previous;
    }
    renderRoomInfo(requestedRoomId || currentRoomId || roomSelect.value);
  }

  function selectRoom(roomId) {
    const normalizedRoomId = String(roomId || '').trim();
    if (!/^\d+$/.test(normalizedRoomId)) {
      return;
    }
    roomSelect.value = normalizedRoomId;
    roomInput.value = '';
    savedState.selectedRoomId = normalizedRoomId;
    vscode.setState(savedState);
    selectMessageView('danmaku');
    renderRoomInfo(normalizedRoomId);
  }

  function renderSnapshot(snapshot) {
    requestedRoomId = String(snapshot.roomId || requestedRoomId || '');
    currentRoomId = String(snapshot.actualRoomId || snapshot.roomId || '');
    const status = String(snapshot.status || 'idle');
    sessionStatus = status;
    const connected = status === 'connected';
    const busy = status === 'connecting' || status === 'reconnecting';
    statusDot.className = `status-dot ${status}`;
    statusText.textContent = formatStatus(snapshot);
    popularity.textContent = Number.isFinite(snapshot.popularity) ? `人气 ${formatNumber(snapshot.popularity)}` : '';
    connectButton.disabled = busy;
    disconnectButton.disabled = status === 'idle';
    openRoomButton.disabled = !currentRoomId;
    renderRoomInfo(requestedRoomId || currentRoomId || roomSelect.value);
    if (Array.isArray(snapshot.messages)) {
      messages = snapshot.messages.slice(-MAX_MESSAGES);
      renderAllMessages();
    }
    if (Array.isArray(snapshot.superChats)) {
      superChats = snapshot.superChats.slice(-MAX_SUPER_CHATS);
      renderAllSuperChats();
    }
    if (connected && currentRoomId) {
      savedState.selectedRoomId = String(snapshot.roomId || currentRoomId);
      vscode.setState(savedState);
    }
  }

  function renderRoomInfo(roomId) {
    const normalizedRoomId = String(roomId || '').trim();
    if (!normalizedRoomId) {
      roomInfo.hidden = true;
      return;
    }

    roomInfo.hidden = false;
    const room = monitoredRooms.find((item) => item.roomId === normalizedRoomId)
      || monitoredRooms.find((item) => item.roomId === currentRoomId);
    if (!room) {
      renderUnmonitoredRoomInfo(normalizedRoomId);
      return;
    }

    roomLiveDot.className = `room-live-dot ${room.status || 'unknown'}`;
    roomAnchorName.textContent = room.anchorName || room.roomId;
    roomAnchorName.title = `${room.anchorName || room.roomId} · ${room.roomId}`;
    roomLiveState.textContent = formatLiveState(room.status);
    roomTitle.textContent = room.title || `房间 ${room.roomId}`;
    roomTitle.title = room.title || `房间 ${room.roomId}`;
    setMetricValue(roomOnline, room.online, room.onlineStale, room.onlineLastSuccessAt, '在线人数');
    setMetricValue(roomGuards, room.guardCount, room.guardCountStale, room.guardCountLastSuccessAt, '舰队人数');
    setMetricValue(roomFans, room.fansCount, room.fansCountStale, room.fansCountLastSuccessAt, '粉丝数');
    bindRoomDuration(room);
    roomInfo.title = room.lastUpdatedAt ? `监控数据更新于 ${formatDateTime(room.lastUpdatedAt)}` : '';
  }

  function renderUnmonitoredRoomInfo(roomId) {
    roomLiveDot.className = 'room-live-dot unknown';
    roomAnchorName.textContent = `房间 ${roomId}`;
    roomAnchorName.title = `房间 ${roomId}`;
    roomLiveState.textContent = '未监控';
    roomTitle.textContent = '未加入在线人数监控列表';
    roomTitle.title = '该房间没有可复用的直播监控数据';
    for (const element of [roomOnline, roomGuards, roomFans]) {
      resetMetricValue(element, '-');
    }
    delete roomDuration.dataset.liveStartTime;
    roomDuration.textContent = '-';
    roomInfo.title = '';
  }

  function setMetricValue(element, value, stale, lastSuccessAt, label) {
    resetMetricValue(element, Number.isFinite(value) ? formatNumber(value) : '-');
    if (stale) {
      element.classList.add('metric-stale');
      const lastSuccessText = lastSuccessAt ? formatDateTime(lastSuccessAt) : '未知时间';
      element.title = `${label}本轮获取失败，正在显示上次成功数据（${lastSuccessText}）`;
    }
  }

  function resetMetricValue(element, text) {
    element.textContent = text;
    element.classList.remove('metric-stale');
    element.removeAttribute('title');
  }

  function bindRoomDuration(room) {
    if (room.status === 'live' && Number(room.liveStartTime) > 0) {
      roomDuration.dataset.liveStartTime = String(room.liveStartTime);
      roomDuration.textContent = formatLiveDuration(room.liveStartTime);
      return;
    }
    delete roomDuration.dataset.liveStartTime;
    roomDuration.textContent = room.status === 'live' ? '-' : '未开播';
  }

  function updateRoomDuration() {
    const liveStartTime = Number(roomDuration.dataset.liveStartTime);
    if (Number.isFinite(liveStartTime) && liveStartTime > 0) {
      roomDuration.textContent = formatLiveDuration(liveStartTime);
    }
  }

  function formatLiveDuration(liveStartTime, nowMs = Date.now()) {
    const elapsedSeconds = Math.max(0, Math.floor(nowMs / 1000) - Number(liveStartTime));
    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    const seconds = elapsedSeconds % 60;
    return `${padClockPart(hours)}:${padClockPart(minutes)}:${padClockPart(seconds)}`;
  }

  function padClockPart(value) {
    return String(value).padStart(2, '0');
  }

  function formatLiveState(status) {
    if (status === 'live') {
      return '直播中';
    }
    if (status === 'offline') {
      return '未开播';
    }
    return '未知';
  }

  function formatStatus(snapshot) {
    switch (snapshot.status) {
      case 'connecting':
        return `正在连接房间 ${snapshot.roomId || ''}`.trim();
      case 'connected':
        return `已连接房间 ${snapshot.actualRoomId || snapshot.roomId || ''}`.trim();
      case 'reconnecting':
        return `正在重连（第 ${snapshot.reconnectAttempt || 1} 次）`;
      case 'error':
        return snapshot.error || '连接失败';
      default:
        return '未连接';
    }
  }

  function appendMessage(message) {
    appendMessages([message]);
  }

  function appendMessages(incomingMessages) {
    const batch = incomingMessages.filter((message) => message && typeof message === 'object');
    if (batch.length === 0) {
      return;
    }
    const shouldScroll = activeMessageView === 'danmaku' && (autoScrollToggle.checked || isNearBottom());
    const overflow = Math.max(0, messages.length + batch.length - MAX_MESSAGES);
    const existingToRemove = Math.min(overflow, messages.length);
    for (let index = 0; index < existingToRemove; index += 1) {
      const firstMessage = messagesElement.querySelector('.message');
      firstMessage?.remove();
    }
    messages = messages.concat(batch).slice(-MAX_MESSAGES);
    const fragment = document.createDocumentFragment();
    for (const message of batch.slice(-MAX_MESSAGES)) {
      fragment.appendChild(createMessageElement(message));
    }
    messagesElement.appendChild(fragment);
    updateMessageCount();
    updateEmptyState();
    if (shouldScroll && autoScrollToggle.checked) {
      scrollToBottom();
    }
  }

  function createRenderDiagnostics(startedAt) {
    return {
      startedAt,
      batches: 0,
      messages: 0,
      maxDeliveryDelayMs: 0,
      maxRenderDurationMs: 0,
      lastBatchId: 0
    };
  }

  function observeRenderBatch(payload, renderDurationMs) {
    renderDiagnostics.batches += 1;
    renderDiagnostics.messages += payload.messages.length;
    renderDiagnostics.maxRenderDurationMs = Math.max(renderDiagnostics.maxRenderDurationMs, renderDurationMs);
    renderDiagnostics.lastBatchId = Number(payload.batchId) || renderDiagnostics.lastBatchId;
    if (Number.isFinite(payload.emittedAt)) {
      renderDiagnostics.maxDeliveryDelayMs = Math.max(
        renderDiagnostics.maxDeliveryDelayMs,
        Math.max(0, Date.now() - payload.emittedAt)
      );
    }
  }

  function reportRenderDiagnostics() {
    const now = Date.now();
    const timerDriftMs = Math.max(0, now - expectedRenderDiagnosticAt);
    expectedRenderDiagnosticAt = now + RENDER_DIAGNOSTIC_INTERVAL_MS;
    if (!['connecting', 'connected', 'reconnecting'].includes(sessionStatus)) {
      renderDiagnostics = createRenderDiagnostics(now);
      return;
    }
    vscode.postMessage({
      type: 'renderDiagnostics',
      windowMs: Math.max(0, now - renderDiagnostics.startedAt),
      batches: renderDiagnostics.batches,
      messages: renderDiagnostics.messages,
      maxDeliveryDelayMs: renderDiagnostics.maxDeliveryDelayMs,
      maxRenderDurationMs: renderDiagnostics.maxRenderDurationMs,
      timerDriftMs,
      listMessages: messages.length,
      lastBatchId: renderDiagnostics.lastBatchId
    });
    renderDiagnostics = createRenderDiagnostics(now);
  }

  function appendSuperChat(superChat) {
    const shouldScroll = activeMessageView === 'superChat' && (autoScrollToggle.checked || isNearBottom());
    const existingIndex = superChats.findIndex((item) => item.id === superChat.id);
    if (existingIndex >= 0) {
      superChats.splice(existingIndex, 1, superChat);
    } else {
      superChats.push(superChat);
      if (superChats.length > MAX_SUPER_CHATS) {
        superChats.shift();
      }
    }
    renderAllSuperChats();
    if (shouldScroll && autoScrollToggle.checked) {
      scrollToBottom();
    }
  }

  function removeSuperChats(ids) {
    const deletedIds = new Set(ids.map((id) => String(id)));
    superChats = superChats.filter((superChat) => !deletedIds.has(String(superChat.id)));
    renderAllSuperChats();
  }

  function renderAllMessages() {
    messagesElement.replaceChildren(emptyState);
    for (const message of messages) {
      messagesElement.appendChild(createMessageElement(message));
    }
    updateMessageCount();
    updateEmptyState();
    if (autoScrollToggle.checked && activeMessageView === 'danmaku') {
      scrollToBottom();
    }
  }

  function renderAllSuperChats() {
    superChatsElement.replaceChildren(superChatEmptyState);
    for (const superChat of superChats) {
      superChatsElement.appendChild(createSuperChatElement(superChat));
    }
    superChatCount.textContent = String(superChats.length);
    superChatEmptyState.hidden = superChats.length > 0;
    if (autoScrollToggle.checked && activeMessageView === 'superChat') {
      scrollToBottom();
    }
  }

  function clearMessages() {
    messages = [];
    superChats = [];
    renderAllMessages();
    renderAllSuperChats();
  }

  function selectMessageView(view) {
    activeMessageView = view === 'superChat' ? 'superChat' : 'danmaku';
    savedState.activeMessageView = activeMessageView;
    vscode.setState(savedState);
    syncMessageView();
    if (autoScrollToggle.checked) {
      scrollToBottom();
    }
  }

  function syncMessageView() {
    const showSuperChats = activeMessageView === 'superChat';
    messagesElement.hidden = showSuperChats;
    superChatsElement.hidden = !showSuperChats;
    danmakuTab.classList.toggle('active', !showSuperChats);
    superChatTab.classList.toggle('active', showSuperChats);
    danmakuTab.setAttribute('aria-selected', String(!showSuperChats));
    superChatTab.setAttribute('aria-selected', String(showSuperChats));
  }

  function normalizeDisplayOptions(value) {
    const stored = value && typeof value === 'object' ? value : {};
    const options = { ...DEFAULT_DISPLAY_OPTIONS };
    for (const key of Object.keys(options)) {
      if (typeof stored[key] === 'boolean') {
        options[key] = stored[key];
      }
    }
    return options;
  }

  function persistDisplaySettings() {
    savedState.displaySettingsExpanded = displaySettingsExpanded;
    savedState.displayOptions = { ...displayOptions };
    vscode.setState(savedState);
  }

  function syncDisplaySettingsControls() {
    displaySettingsPanel.hidden = !displaySettingsExpanded;
    displaySettingsButton.setAttribute('aria-expanded', String(displaySettingsExpanded));
    displaySettingsButton.classList.toggle('active', displaySettingsExpanded);
    for (const input of displayOptionInputs) {
      const key = input.dataset.displayOption;
      input.checked = Boolean(key && displayOptions[key]);
    }
  }

  function postEmojiDisplaySetting() {
    vscode.postMessage({ type: 'setShowEmoji', showEmoji: displayOptions.showEmoji });
  }

  function emojiSequenceToText(sequence) {
    const normalized = sequence.replace(/[\uFE0E\uFE0F]/g, '').replace(/\p{Emoji_Modifier}/gu, '');
    const alias = EMOJI_TEXT_ALIASES[normalized];
    if (alias) {
      return `[${alias}]`;
    }
    const codePoints = Array.from(sequence)
      .filter((character) => character !== '\uFE0E' && character !== '\uFE0F')
      .map((character) => `U+${character.codePointAt(0).toString(16).toUpperCase()}`);
    return `[Emoji ${codePoints.join(' ')}]`;
  }

  function formatEmojiContent(content, showEmoji) {
    const text = String(content || '');
    if (showEmoji) {
      return text;
    }
    return text.replace(EMOJI_PATTERN, (sequence) => emojiSequenceToText(sequence));
  }

  function isMessageVisible(message) {
    return formatEmojiContent(message.content, displayOptions.showEmoji).length > 0;
  }

  function createMessageElement(message) {
    const row = document.createElement('article');
    row.className = 'message';
    row.hidden = !isMessageVisible(message);
    row.classList.toggle('color-bar-hidden', !displayOptions.showColorBar);
    if (Number.isInteger(message.color)) {
      row.style.setProperty('--danmaku-color', `#${message.color.toString(16).padStart(6, '0').slice(-6)}`);
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    let hasMeta = false;
    if (displayOptions.showTime) {
      const time = document.createElement('time');
      time.textContent = formatTime(message.receivedAt);
      meta.appendChild(time);
      hasMeta = true;
    }
    if (displayOptions.showMedal && message.medalName) {
      const medal = document.createElement('span');
      medal.className = 'medal';
      medal.textContent = `${message.medalName} ${message.medalLevel || ''}`.trim();
      meta.appendChild(medal);
      hasMeta = true;
    }
    if (displayOptions.showAdmin && message.isAdmin) {
      const admin = document.createElement('span');
      admin.className = 'admin-badge';
      admin.textContent = '房管';
      meta.appendChild(admin);
      hasMeta = true;
    }
    if (displayOptions.showUsername) {
      const username = document.createElement('span');
      username.className = 'username';
      username.textContent = message.username || '匿名用户';
      meta.appendChild(username);
      hasMeta = true;
    }
    if (displayOptions.showUid && message.uid) {
      const uid = document.createElement('span');
      uid.className = 'uid';
      uid.textContent = `UID ${message.uid}`;
      meta.appendChild(uid);
      hasMeta = true;
    }

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = formatEmojiContent(message.content, displayOptions.showEmoji);
    if (hasMeta) {
      row.appendChild(meta);
    } else {
      content.classList.add('message-content-only');
    }
    row.appendChild(content);
    return row;
  }

  function createSuperChatElement(superChat) {
    const row = document.createElement('article');
    row.className = 'message super-chat';
    const accentColor = normalizeHexColor(superChat.backgroundColor);
    if (accentColor) {
      row.style.setProperty('--super-chat-color', accentColor);
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta super-chat-meta';
    if (displayOptions.showTime) {
      const time = document.createElement('time');
      time.textContent = formatTime(superChat.receivedAt);
      meta.appendChild(time);
    }

    const typeBadge = document.createElement('span');
    typeBadge.className = 'super-chat-badge';
    typeBadge.textContent = 'SC';
    meta.appendChild(typeBadge);

    const price = document.createElement('span');
    price.className = 'super-chat-price';
    price.textContent = formatPrice(superChat.price);
    meta.appendChild(price);

    if (Number(superChat.durationSeconds) > 0) {
      const duration = document.createElement('span');
      duration.className = 'super-chat-duration';
      duration.textContent = `${Math.round(Number(superChat.durationSeconds))} 秒`;
      meta.appendChild(duration);
    }
    if (displayOptions.showMedal && superChat.medalName) {
      const medal = document.createElement('span');
      medal.className = 'medal';
      medal.textContent = `${superChat.medalName} ${superChat.medalLevel || ''}`.trim();
      meta.appendChild(medal);
    }
    if (displayOptions.showAdmin && superChat.isAdmin) {
      const admin = document.createElement('span');
      admin.className = 'admin-badge';
      admin.textContent = '房管';
      meta.appendChild(admin);
    }
    if (displayOptions.showUsername) {
      const username = document.createElement('span');
      username.className = 'username';
      username.textContent = superChat.username || '匿名用户';
      meta.appendChild(username);
    }
    if (displayOptions.showUid && superChat.uid) {
      const uid = document.createElement('span');
      uid.className = 'uid';
      uid.textContent = `UID ${superChat.uid}`;
      meta.appendChild(uid);
    }

    const content = document.createElement('div');
    content.className = 'message-content super-chat-content';
    content.textContent = formatEmojiContent(superChat.content, displayOptions.showEmoji) || '（无留言内容）';
    row.append(meta, content);
    return row;
  }

  function updateMessageCount() {
    const visibleCount = messages.reduce((count, message) => count + (isMessageVisible(message) ? 1 : 0), 0);
    messageCount.textContent = String(visibleCount);
  }

  function updateEmptyState() {
    const hasVisibleMessage = messages.some((message) => isMessageVisible(message));
    emptyState.hidden = hasVisibleMessage;
    emptyState.textContent = messages.length > 0 && !hasVisibleMessage ? '暂无可显示内容' : '等待弹幕...';
  }

  function isNearBottom() {
    const element = activeMessageView === 'superChat' ? superChatsElement : messagesElement;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }

  function scrollToBottom() {
    const element = activeMessageView === 'superChat' ? superChatsElement : messagesElement;
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }

  function createOption(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(value);
  }

  function formatPrice(value) {
    const price = Number(value);
    return `¥${Number.isFinite(price) && price >= 0 ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(price) : '0'}`;
  }

  function normalizeHexColor(value) {
    const color = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : '';
  }

  function formatTime(value) {
    const date = new Date(Number(value) || Date.now());
    return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatDateTime(value) {
    const date = new Date(Number(value));
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '-';
  }

  setInterval(updateRoomDuration, 1000);
  setInterval(reportRenderDiagnostics, RENDER_DIAGNOSTIC_INTERVAL_MS);
  vscode.postMessage({ type: 'ready' });
})();
