import { buildOverlayStyleVars, buildOverlaySubtitleView } from './overlay-state.js';

const state = {
  app: null,
  reconnectTimerId: null,
  selectionActive: false,
};

const elements = {
  root: document.documentElement,
  subtitle: document.getElementById('overlay-subtitle'),
  text: document.getElementById('overlay-subtitle-text'),
};

elements.subtitle.addEventListener('pointerenter', () => setInteractive(true));
elements.subtitle.addEventListener('pointerleave', () => {
  if (!state.selectionActive && document.getSelection()?.isCollapsed !== false) {
    setInteractive(false);
  }
});
elements.subtitle.addEventListener('pointerdown', () => {
  state.selectionActive = true;
  setInteractive(true);
});
document.addEventListener('pointerup', () => {
  state.selectionActive = false;
  if (document.getSelection()?.isCollapsed !== false && !isPointerOverSubtitle()) {
    setInteractive(false);
  }
});
document.addEventListener('selectionchange', () => {
  const hasSelection = document.getSelection()?.isCollapsed === false;
  setInteractive(hasSelection || isPointerOverSubtitle());
});
window.addEventListener('blur', () => {
  state.selectionActive = false;
  setInteractive(false);
});

void bootstrap();

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

    if (message.type === 'overlay:open-yomitan-settings') {
      window.sentenceMinerOverlay?.openYomitanSettings?.();
    }
  });

  socket.addEventListener('close', () => {
    hideSubtitle();
    setInteractive(false);
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
}

function applyStyleVars() {
  for (const [name, value] of Object.entries(buildOverlayStyleVars(state.app))) {
    elements.root.style.setProperty(name, value);
  }
}

function hideSubtitle() {
  elements.text.textContent = '';
  elements.subtitle.hidden = true;
}

function setInteractive(interactive) {
  window.sentenceMinerOverlay?.setInteractive?.(Boolean(interactive));
}

function isPointerOverSubtitle() {
  return elements.subtitle.matches(':hover');
}
