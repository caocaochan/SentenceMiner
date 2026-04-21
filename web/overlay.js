import {
  hasVisibleYomitanPopup,
  shouldCloseYomitanPopupOnPointerDown,
  shouldOverlayBeInteractive,
} from './overlay-interactivity.js';
import { buildOverlayStatusPayload, buildOverlayStyleVars, buildOverlaySubtitleView } from './overlay-state.js';

const state = {
  app: null,
  hasSelection: false,
  interactive: false,
  pointerOverSubtitle: false,
  reconnectTimerId: null,
  selectionActive: false,
  yomitanPopupVisibleFromDom: false,
  yomitanPopupVisibleFromMessage: false,
};

const elements = {
  root: document.documentElement,
  subtitle: document.getElementById('overlay-subtitle'),
  text: document.getElementById('overlay-subtitle-text'),
};

elements.subtitle.addEventListener('pointerenter', () => {
  state.pointerOverSubtitle = true;
  updateInteractive();
});
elements.subtitle.addEventListener('pointerleave', () => {
  state.pointerOverSubtitle = false;
  updateInteractive();
});
elements.subtitle.addEventListener('pointerdown', () => {
  state.selectionActive = true;
  updateInteractive();
});
document.addEventListener('pointerup', () => {
  state.selectionActive = false;
  updateSelectionState();
  updateInteractive();
});
document.addEventListener('pointerdown', (event) => {
  if (!shouldCloseYomitanPopupOnPointerDown({
    button: event.button,
    clientX: event.clientX,
    clientY: event.clientY,
    yomitanPopupVisible: isYomitanPopupVisible(),
  })) {
    return;
  }

  closeYomitanPopup();
}, true);
document.addEventListener('selectionchange', () => {
  updateSelectionState();
  updateInteractive();
});
window.addEventListener('blur', () => {
  state.selectionActive = false;
  state.pointerOverSubtitle = false;
  state.hasSelection = false;
  updateInteractive();
});
window.addEventListener('message', (event) => {
  const { data } = event;
  if (!data || typeof data !== 'object' || data.sentenceMinerOverlay !== true) {
    return;
  }

  if (data.type === 'yomitan-popup-visibility') {
    state.yomitanPopupVisibleFromMessage = Boolean(data.visible);
    console.info(`SentenceMiner: Yomitan popup visibility ${state.yomitanPopupVisibleFromMessage ? 'visible' : 'hidden'}.`);
    updateInteractive();
  }
});

void bootstrap();
window.setInterval(reportOverlayStatus, 1000);
window.setInterval(updateYomitanPopupVisibility, 250);

const popupObserver = new MutationObserver(updateYomitanPopupVisibility);
popupObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['class', 'hidden', 'style'],
  childList: true,
  subtree: true,
});

async function bootstrap() {
  await refreshState({ suppressErrors: true });
  connectWebSocket();
}

async function refreshState(options = {}) {
  const { suppressErrors = false } = options;

  try {
    const response = await fetch('/api/state', {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`State request failed with status ${response.status}.`);
    }

    state.app = await response.json();
    render();
  } catch (error) {
    if (!suppressErrors) {
      throw error;
    }
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    if (state.reconnectTimerId !== null) {
      window.clearTimeout(state.reconnectTimerId);
      state.reconnectTimerId = null;
    }
    void refreshState({ suppressErrors: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      state.app = message.payload;
      render();
      return;
    }

    if (message.type === 'subtitle-update') {
      applySubtitleUpdate(message.payload);
      render();
      return;
    }

    if (message.type === 'overlay:open-yomitan-settings') {
      window.sentenceMinerOverlay?.openYomitanSettings?.();
    }
  });

  socket.addEventListener('close', () => {
    state.app = null;
    hideSubtitle();
    reportOverlayStatus();
    state.yomitanPopupVisibleFromDom = false;
    state.yomitanPopupVisibleFromMessage = false;
    updateInteractive();
    if (state.reconnectTimerId === null) {
      state.reconnectTimerId = window.setTimeout(() => {
        state.reconnectTimerId = null;
        connectWebSocket();
      }, 1000);
    }
  });

  socket.addEventListener('error', () => {
    socket.close();
  });
}

function render() {
  applyStyleVars();
  const view = buildOverlaySubtitleView(state.app);

  if (!view.visible) {
    hideSubtitle();
    return;
  }

  elements.text.textContent = view.text;
  elements.subtitle.hidden = false;
  reportOverlayStatus();
}

function applySubtitleUpdate(payload) {
  if (!state.app?.state || !payload || typeof payload !== 'object') {
    void refreshState({ suppressErrors: true });
    return;
  }

  state.app = {
    ...state.app,
    state: {
      ...state.app.state,
      session: payload.session ?? null,
      currentSubtitle: payload.currentSubtitle ?? null,
      currentCueId: payload.currentCueId ?? null,
    },
  };
}

function applyStyleVars() {
  for (const [name, value] of Object.entries(buildOverlayStyleVars(state.app))) {
    elements.root.style.setProperty(name, value);
  }
}

function hideSubtitle() {
  elements.text.textContent = '';
  elements.subtitle.hidden = true;
  reportOverlayStatus();
}

function setInteractive(interactive) {
  window.sentenceMinerOverlay?.setInteractive?.(Boolean(interactive));
}

function updateInteractive() {
  const interactive = shouldOverlayBeInteractive({
    hasSelection: state.hasSelection,
    pointerOverSubtitle: state.pointerOverSubtitle || isPointerOverSubtitle(),
    selectionActive: state.selectionActive,
    yomitanPopupVisible: isYomitanPopupVisible(),
  });

  if (state.interactive === interactive) {
    return;
  }

  state.interactive = interactive;
  setInteractive(interactive);
}

function updateSelectionState() {
  state.hasSelection = document.getSelection()?.isCollapsed === false;
}

function updateYomitanPopupVisibility() {
  const visible = hasVisibleYomitanPopup(document);
  if (visible === state.yomitanPopupVisibleFromDom) {
    return;
  }

  state.yomitanPopupVisibleFromDom = visible;
  updateInteractive();
}

function isYomitanPopupVisible() {
  return state.yomitanPopupVisibleFromMessage || state.yomitanPopupVisibleFromDom;
}

function closeYomitanPopup() {
  window.postMessage({
    sentenceMinerOverlay: true,
    type: 'close-yomitan-popup',
  }, '*');
}

function reportOverlayStatus() {
  const payload = buildOverlayStatusPayload(state.app);
  const body = JSON.stringify(payload);

  if (navigator.sendBeacon?.('/api/overlay/status', new Blob([body], { type: 'application/json' }))) {
    return;
  }

  fetch('/api/overlay/status', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body,
    keepalive: true,
  }).catch(() => {
    // Status heartbeats are best effort; rendering should never depend on them.
  });
}

function isPointerOverSubtitle() {
  return elements.subtitle.matches(':hover');
}
