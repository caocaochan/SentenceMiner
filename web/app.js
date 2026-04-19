const state = {
  connection: 'connecting',
  app: null,
  autoScroll: true,
  pendingActions: new Set(),
};

const elements = {
  connectionPill: document.getElementById('connection-pill'),
  fileName: document.getElementById('file-name'),
  currentTime: document.getElementById('current-time'),
  currentSubtitle: document.getElementById('current-subtitle'),
  historyCount: document.getElementById('history-count'),
  historyList: document.getElementById('history-list'),
};

elements.historyList.addEventListener('scroll', () => {
  const threshold = 40;
  state.autoScroll = elements.historyList.scrollTop < threshold;
});

bootstrap();

async function bootstrap() {
  await refreshState();
  connectWebSocket();
}

async function refreshState() {
  const response = await fetch('/api/state');
  const payload = await response.json();
  state.app = payload;
  render();
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    state.connection = 'live';
    render();
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      state.app = message.payload;
      render();
    }
  });

  socket.addEventListener('close', () => {
    state.connection = 'offline';
    render();
    setTimeout(connectWebSocket, 1000);
  });

  socket.addEventListener('error', () => {
    socket.close();
  });
}

function render() {
  const transcriptState = state.app?.state ?? { session: null, currentSubtitle: null, history: [] };
  const currentSubtitle = transcriptState.currentSubtitle;
  const history = [...(transcriptState.history ?? [])].reverse();

  elements.connectionPill.textContent = state.connection === 'live' ? 'Live' : state.connection === 'offline' ? 'Reconnecting' : 'Connecting';
  elements.connectionPill.className = `pill ${state.connection === 'live' ? 'pill-success' : 'pill-muted'}`;
  elements.fileName.textContent = transcriptState.session?.filePath ?? 'No file loaded';
  elements.currentTime.textContent = currentSubtitle ? formatRange(currentSubtitle.startMs, currentSubtitle.endMs) : '--:--.--';
  elements.currentSubtitle.textContent = currentSubtitle?.text ?? 'Waiting for subtitles from mpv…';
  elements.currentSubtitle.className = `subtitle-display ${currentSubtitle?.text ? '' : 'empty'}`;
  elements.historyCount.textContent = `${history.length} ${history.length === 1 ? 'line' : 'lines'}`;

  const previousScrollHeight = elements.historyList.scrollHeight;
  const previousScrollTop = elements.historyList.scrollTop;

  elements.historyList.innerHTML = '';
  history.forEach((entry, index) => {
    const item = document.createElement('article');
    item.className = 'history-item';
    if (currentSubtitle && isSameSubtitle(currentSubtitle, entry)) {
      item.classList.add('history-item-active');
    }

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = formatRange(entry.startMs, entry.endMs);

    const text = document.createElement('div');
    text.className = 'history-text';
    text.textContent = entry.text;

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const goToButton = buildHistoryActionButton('Go to', 'go-to', entry);
    const mineButton = buildHistoryActionButton('Mine', 'mine', entry);

    actions.append(goToButton, mineButton);
    item.append(meta, text, actions);
    item.dataset.index = String(index);
    elements.historyList.append(item);
  });

  if (state.autoScroll) {
    elements.historyList.scrollTop = 0;
  } else {
    const delta = elements.historyList.scrollHeight - previousScrollHeight;
    elements.historyList.scrollTop = previousScrollTop + delta;
  }
}

function buildHistoryActionButton(label, action, entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'history-button';
  button.textContent = label;
  button.disabled = isHistoryActionPending(action, entry);
  button.addEventListener('click', () => {
    void runHistoryAction(action, entry);
  });
  return button;
}

async function runHistoryAction(action, entry) {
  const pendingKey = buildHistoryActionKey(action, entry);
  if (state.pendingActions.has(pendingKey)) {
    return;
  }

  state.pendingActions.add(pendingKey);
  render();

  try {
    const endpoint = action === 'go-to' ? '/api/history/go-to' : '/api/history/mine';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(entry),
    });

    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.message ?? `Request failed with status ${response.status}.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    window.alert(message);
  } finally {
    state.pendingActions.delete(pendingKey);
    render();
  }
}

function isHistoryActionPending(action, entry) {
  return state.pendingActions.has(buildHistoryActionKey(action, entry));
}

function buildHistoryActionKey(action, entry) {
  return `${action}:${buildHistoryEntryKey(entry)}`;
}

function buildHistoryEntryKey(entry) {
  return [entry.sessionId, entry.filePath, entry.startMs ?? 'nil', entry.endMs ?? 'nil', entry.text].join('::');
}

function isSameSubtitle(a, b) {
  return a.sessionId === b.sessionId && a.startMs === b.startMs && a.endMs === b.endMs && a.text === b.text;
}

function formatRange(startMs, endMs) {
  if (startMs == null && endMs == null) {
    return '--:--.--';
  }

  return `${formatTimestamp(startMs ?? 0)} - ${formatTimestamp(endMs ?? 0)}`;
}

function formatTimestamp(ms) {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const milliseconds = total % 1000;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}
