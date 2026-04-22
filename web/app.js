import {
  buildBatchHistoryMineRequest,
  buildHistoryEntryKey,
  reconcileSelectedHistoryKeys,
  toggleSelectedHistoryKeys,
} from './history-selection.js';
import {
  buildTranscriptBookmarkKey,
  buildHighlightedTranscriptParts,
  buildTranscriptStructureSignature,
  computeTranscriptFollowScrollTarget,
  computeTranscriptItemUiState,
  filterTranscriptEntriesForBookmarkView,
  shouldHandleTranscriptBookmarkShortcut,
  shouldRebuildTranscriptList,
} from './transcript-render.js';
import {
  buildTranscriptEmptyState,
  buildTranscriptStatusLabel,
  resolveTranscriptFilePath,
  resolveThemePreference,
  shouldRefreshSettingsOptions,
  shouldUseFallbackStatePolling,
} from './ui-state.js';
import {
  CUSTOM_FONT_OPTION_VALUE,
  resolveFontPickerState,
  resolveFontSettingValue,
} from './font-picker.js';

const state = {
  connection: 'connecting',
  app: null,
  pendingActions: new Set(),
  selectedHistoryKeys: new Set(),
  bookmarkedTranscriptKeys: new Set(),
  showBookmarkedOnly: false,
  toasts: [],
  settingsModalOpen: false,
  settingsOptions: {
    decks: [],
    noteTypes: [],
    noteFields: [],
    fonts: [],
  },
  settingsOptionsLoading: false,
  settingsOptionsError: '',
  settingsSaving: false,
  settingsSaveError: '',
  settingsActiveTab: 'anki',
  settingsModalReturnFocusEl: null,
  settingsRequestId: 0,
  renderedTranscriptSignature: null,
  renderedCueElements: new Map(),
  autoScrollLoopId: null,
  autoScrollTargetY: null,
  autoScrollLastTimestamp: null,
  autoScrollPausedByUser: false,
  autoScrollListenersAttached: false,
  lastScrolledCueId: null,
};

const AUTO_SCROLL_TIME_CONSTANT_S = 0.25;
const AUTO_SCROLL_CONVERGENCE_PX = 0.5;
const AUTO_SCROLL_MAX_FRAME_DT_S = 0.1;
const STATE_POLL_INTERVAL_MS = 2000;
const TRANSCRIPT_BOOKMARKS_STORAGE_KEY = 'sentenceminer:transcript-bookmarks';
const SETTINGS_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');
let reconnectTimerId = null;
let statePollIntervalId = null;
let nextToastId = 0;

const elements = {
  hero: document.querySelector('.command-bar'),
  connectionPill: document.getElementById('connection-pill'),
  fileName: document.getElementById('file-name'),
  historyCount: document.getElementById('history-count'),
  transcriptStatus: document.getElementById('transcript-status'),
  historySelectionCount: document.getElementById('history-selection-count'),
  historyList: document.getElementById('history-list'),
  historyMineSelected: document.getElementById('history-mine-selected'),
  historyBookmarkFilter: document.getElementById('history-bookmark-filter'),
  toastRegion: document.getElementById('toast-region'),
  themeToggle: document.getElementById('theme-toggle'),
  settingsButton: document.getElementById('settings-button'),
  settingsModal: document.getElementById('settings-modal'),
  settingsPanel: document.getElementById('settings-panel'),
  settingsBackdrop: document.getElementById('settings-backdrop'),
  settingsClose: document.getElementById('settings-close'),
  settingsCancel: document.getElementById('settings-cancel'),
  settingsSave: document.getElementById('settings-save'),
  settingsForm: document.getElementById('settings-form'),
  settingsTabsContainer: document.querySelector('.settings-tabs'),
  settingsTabs: [...document.querySelectorAll('[data-settings-tab]')],
  settingsTabPanels: [...document.querySelectorAll('[data-settings-panel]')],
  settingsOptionsStatus: document.getElementById('settings-options-status'),
  settingsError: document.getElementById('settings-error'),
  settingsAnkiDeck: document.getElementById('settings-anki-deck'),
  settingsAnkiNoteType: document.getElementById('settings-anki-note-type'),
  settingsAnkiExtraQuery: document.getElementById('settings-anki-extra-query'),
  settingsFieldSubtitle: document.getElementById('settings-field-subtitle'),
  settingsKnownWordField: document.getElementById('settings-known-word-field'),
  settingsFieldAudio: document.getElementById('settings-field-audio'),
  settingsFieldImage: document.getElementById('settings-field-image'),
  settingsFieldSource: document.getElementById('settings-field-source'),
  settingsFieldTime: document.getElementById('settings-field-time'),
  settingsFieldFilename: document.getElementById('settings-field-filename'),
  settingsAnkiFilenameTemplate: document.getElementById('settings-anki-filename-template'),
  settingsRuntimeCaptureAudio: document.getElementById('settings-runtime-capture-audio'),
  settingsRuntimeCaptureImage: document.getElementById('settings-runtime-capture-image'),
  settingsCaptureAudioPrePaddingMs: document.getElementById('settings-capture-audio-pre-padding-ms'),
  settingsCaptureAudioPostPaddingMs: document.getElementById('settings-capture-audio-post-padding-ms'),
  settingsCaptureAudioFormat: document.getElementById('settings-capture-audio-format'),
  settingsCaptureAudioCodec: document.getElementById('settings-capture-audio-codec'),
  settingsCaptureAudioBitrate: document.getElementById('settings-capture-audio-bitrate'),
  settingsCaptureImageFormat: document.getElementById('settings-capture-image-format'),
  settingsCaptureImageQuality: document.getElementById('settings-capture-image-quality'),
  settingsCaptureImageMaxWidth: document.getElementById('settings-capture-image-max-width'),
  settingsCaptureImageMaxHeight: document.getElementById('settings-capture-image-max-height'),
  settingsCaptureImageIncludeSubtitles: document.getElementById('settings-capture-image-include-subtitles'),
  settingsCaptureAdvanced: document.getElementById('settings-capture-advanced'),
  settingsIPlusOneEnabled: document.getElementById('settings-i-plus-one-enabled'),
  settingsAppearanceSubtitleCardFontFamilySelect: document.getElementById('settings-appearance-subtitle-card-font-family-select'),
  settingsAppearanceSubtitleCardFontFamilyCustomField: document.getElementById('settings-appearance-subtitle-card-font-family-custom-field'),
  settingsAppearanceSubtitleCardFontFamilyCustom: document.getElementById('settings-appearance-subtitle-card-font-family-custom'),
  settingsAppearanceSubtitleCardFontSizePx: document.getElementById('settings-appearance-subtitle-card-font-size-px'),
};

elements.themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});
elements.settingsButton.addEventListener('click', () => {
  openSettingsModal();
});
elements.historyMineSelected.addEventListener('click', () => {
  void runMineSelectedAction();
});
elements.historyBookmarkFilter.addEventListener('click', () => {
  state.showBookmarkedOnly = !state.showBookmarkedOnly;
  state.renderedTranscriptSignature = null;
  render();
});
elements.settingsClose.addEventListener('click', closeSettingsModal);
elements.settingsCancel.addEventListener('click', closeSettingsModal);
elements.settingsBackdrop.addEventListener('click', closeSettingsModal);
elements.settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSettings();
});
elements.settingsAnkiNoteType.addEventListener('change', () => {
  void refreshSettingsOptions(elements.settingsAnkiNoteType.value, elements.settingsAnkiDeck.value);
});
elements.settingsAppearanceSubtitleCardFontFamilySelect.addEventListener('change', () => {
  syncSubtitleCardFontCustomInputVisibility();
});
elements.settingsTabsContainer?.addEventListener('click', (event) => {
  const tab = event.target instanceof Element ? event.target.closest('[data-settings-tab]') : null;
  if (!(tab instanceof HTMLElement)) {
    return;
  }

  activateSettingsTab(tab.dataset.settingsTab);
});
document.addEventListener('keydown', handleDocumentKeydown);

initTheme();
initTranscriptBookmarks();
bootstrap();

function initTheme() {
  const preferredTheme = resolveThemePreference(
    localStorage.getItem('theme'),
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );
  document.documentElement.setAttribute('data-theme', preferredTheme);
}

function initTranscriptBookmarks() {
  state.bookmarkedTranscriptKeys = loadTranscriptBookmarks();
}

async function bootstrap() {
  initializeStickyLayout();
  await refreshState({ suppressErrors: true });
  connectWebSocket();
}

function initializeStickyLayout() {
  syncStickyLayout();
  window.addEventListener('resize', syncStickyLayout);
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

    const payload = await response.json();
    state.app = payload;
    if (!state.settingsModalOpen) {
      hydrateSettingsForm();
    }
    render();
  } catch (error) {
    if (suppressErrors) {
      return;
    }

    throw error;
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    if (reconnectTimerId !== null) {
      window.clearTimeout(reconnectTimerId);
      reconnectTimerId = null;
    }
    state.connection = 'live';
    stopStatePolling();
    render();
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

    if (message.type === 'toast') {
      showToast(message.payload?.message, message.payload?.kind);
      return;
    }

    if (message.type === 'bookmark-current') {
      toggleTranscriptBookmarkForCueId(message.payload?.currentCueId, message.payload?.sessionId);
    }
  });

  socket.addEventListener('close', () => {
    state.connection = 'offline';
    startStatePolling();
    render();
    if (reconnectTimerId === null) {
      reconnectTimerId = window.setTimeout(() => {
        reconnectTimerId = null;
        connectWebSocket();
      }, 1000);
    }
  });

  socket.addEventListener('error', () => {
    socket.close();
  });
}

function startStatePolling() {
  if (statePollIntervalId !== null || !shouldUseFallbackStatePolling(state.connection)) {
    return;
  }

  statePollIntervalId = window.setInterval(() => {
    void refreshState({ suppressErrors: true });
  }, STATE_POLL_INTERVAL_MS);
}

function stopStatePolling() {
  if (statePollIntervalId === null) {
    return;
  }

  window.clearInterval(statePollIntervalId);
  statePollIntervalId = null;
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

function render() {
  applyAppearanceSettings();
  renderTranscript();
  renderSettingsUi();
  renderToasts();
  syncStickyLayout();
}

function renderTranscript() {
  const transcriptState = state.app?.state ?? {
    session: null,
    currentSubtitle: null,
    transcript: [],
    currentCueId: null,
    transcriptStatus: 'unavailable',
    transcriptMessage: '',
  };
  const transcriptEntries = transcriptState.transcript ?? transcriptState.history ?? [];
  const transcriptActionsEnabled = Boolean(transcriptState.session && state.connection === 'live');
  state.selectedHistoryKeys = reconcileSelectedHistoryKeys(state.selectedHistoryKeys, transcriptEntries);
  const selectedEntries = transcriptEntries.filter((entry) => state.selectedHistoryKeys.has(buildHistoryEntryKey(entry)));
  const bookmarkedEntries = transcriptEntries.filter((entry) =>
    state.bookmarkedTranscriptKeys.has(buildTranscriptBookmarkKey(entry)),
  );
  const visibleTranscriptEntries = filterTranscriptEntriesForBookmarkView(
    transcriptEntries,
    state.bookmarkedTranscriptKeys,
    state.showBookmarkedOnly,
  );

  elements.connectionPill.textContent =
    state.connection === 'live' ? 'Live' : state.connection === 'offline' ? 'Reconnecting' : 'Connecting';
  elements.connectionPill.className = `status-pill ${state.connection === 'live' ? 'status-pill-success' : 'status-pill-muted'}`;
  const filePath = resolveTranscriptFilePath(transcriptState);
  elements.fileName.textContent = filePath || 'No file loaded';
  elements.fileName.title = filePath;
  elements.fileName.tabIndex = filePath ? 0 : -1;
  elements.historyCount.textContent = `${transcriptEntries.length} ${transcriptEntries.length === 1 ? 'line' : 'lines'}`;
  elements.transcriptStatus.textContent = buildTranscriptStatusLabel(transcriptState);
  elements.transcriptStatus.hidden = !elements.transcriptStatus.textContent;
  elements.historySelectionCount.textContent = `${selectedEntries.length} selected`;
  elements.historyMineSelected.disabled =
    !transcriptActionsEnabled || selectedEntries.length === 0 || isAnyBatchHistoryActionPending('mine-selected');
  elements.historyBookmarkFilter.disabled = transcriptEntries.length === 0;
  elements.historyBookmarkFilter.setAttribute('aria-pressed', String(state.showBookmarkedOnly));
  elements.historyBookmarkFilter.title = state.showBookmarkedOnly ? 'Show all transcript lines' : 'Show bookmarked lines only';
  elements.historyBookmarkFilter.querySelector('span').textContent =
    bookmarkedEntries.length === 1 ? '1 bookmark' : `${bookmarkedEntries.length} bookmarks`;

  if (transcriptEntries.length === 0) {
    state.renderedTranscriptSignature = buildTranscriptStructureSignature(visibleTranscriptEntries);
    state.renderedCueElements = new Map();
    state.lastScrolledCueId = null;
    renderEmptyTranscriptState(transcriptState);
    return;
  }

  if (visibleTranscriptEntries.length === 0) {
    state.renderedTranscriptSignature = buildTranscriptStructureSignature(visibleTranscriptEntries);
    state.renderedCueElements = new Map();
    state.lastScrolledCueId = null;
    renderBookmarkedTranscriptEmptyState();
    return;
  }

  if (shouldRebuildTranscriptList(state.renderedTranscriptSignature, visibleTranscriptEntries)) {
    rebuildTranscriptList(visibleTranscriptEntries);
    state.renderedTranscriptSignature = buildTranscriptStructureSignature(visibleTranscriptEntries);
    state.lastScrolledCueId = null;
  }

  updateTranscriptItemUi(
    visibleTranscriptEntries,
    transcriptState.currentCueId,
    transcriptEntries,
    transcriptActionsEnabled,
  );
  if (transcriptState.currentCueId !== state.lastScrolledCueId) {
    state.lastScrolledCueId = transcriptState.currentCueId;
    syncCurrentCueScroll(transcriptState.currentCueId);
  }
}

function renderSettingsUi() {
  elements.settingsModal.hidden = !state.settingsModalOpen;
  elements.settingsButton.setAttribute('aria-expanded', String(state.settingsModalOpen));
  document.body.classList.toggle('modal-open', state.settingsModalOpen);
  renderSettingsTabs();

  const optionsStatus = state.settingsOptionsLoading
    ? 'Loading decks, note types, note fields, and installed fonts...'
    : state.settingsOptionsError || 'Settings are saved to sentenceminer.conf and applied immediately.';

  elements.settingsOptionsStatus.textContent = optionsStatus;
  elements.settingsOptionsStatus.className = `settings-status ${state.settingsOptionsError ? 'settings-status-warning' : 'muted'}`;
  elements.settingsError.textContent = state.settingsSaveError;
  elements.settingsError.hidden = !state.settingsSaveError;

  elements.settingsSave.disabled = state.settingsSaving;
  elements.settingsSave.textContent = state.settingsSaving ? 'Saving...' : 'Save settings';
}

function renderSettingsTabs() {
  elements.settingsTabs.forEach((tab) => {
    const isActive = tab.dataset.settingsTab === state.settingsActiveTab;
    tab.setAttribute('aria-selected', String(isActive));
    tab.tabIndex = 0;
  });
  elements.settingsTabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== state.settingsActiveTab;
  });
}

function activateSettingsTab(tabName) {
  const nextTab = elements.settingsTabs.some((tab) => tab.dataset.settingsTab === tabName)
    ? tabName
    : 'anki';
  state.settingsActiveTab = nextTab;
  renderSettingsTabs();
}

window.setSettingsTab = activateSettingsTab;

function buildHistoryActionButton(label, action, entry, iconName) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `history-button ${action === 'mine' ? 'history-button-primary' : ''}`;
  button.setAttribute('aria-label', `${label}: ${entry.text}`);
  button.title = label;
  button.append(buildIcon(iconName));
  button.disabled = isHistoryActionPending(action, entry);
  button.addEventListener('click', () => {
    void runHistoryAction(action, entry);
  });
  return button;
}

function buildTranscriptBookmarkButton(entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'history-button history-bookmark-button';
  button.append(buildIcon('bookmark'));
  button.addEventListener('click', () => {
    toggleTranscriptBookmark(entry);
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
    showToast(message, 'error');
  } finally {
    state.pendingActions.delete(pendingKey);
    render();
  }
}

async function runMineSelectedAction() {
  const transcriptEntries = state.app?.state?.transcript ?? state.app?.state?.history ?? [];
  const request = buildBatchHistoryMineRequest(transcriptEntries, state.selectedHistoryKeys);
  const pendingKey = buildBatchHistoryActionKey('mine-selected', request.entries);
  if (request.entries.length === 0 || state.pendingActions.has(pendingKey)) {
    return;
  }

  state.pendingActions.add(pendingKey);
  render();

  try {
    const response = await fetch('/api/history/mine', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.message ?? `Request failed with status ${response.status}.`);
    }

    state.selectedHistoryKeys.clear();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(message, 'error');
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

function buildBatchHistoryActionKey(action, entries) {
  return `${action}:${entries.map((entry) => buildHistoryEntryKey(entry)).join('|')}`;
}

function isBatchHistoryActionPending(action, entries) {
  if (entries.length === 0) {
    return false;
  }

  return state.pendingActions.has(buildBatchHistoryActionKey(action, entries));
}

function isAnyBatchHistoryActionPending(action) {
  const prefix = `${action}:`;
  return [...state.pendingActions].some((pendingKey) => pendingKey.startsWith(prefix));
}

function applyHistorySelectionToggle(entries, entry, checked) {
  state.selectedHistoryKeys = toggleSelectedHistoryKeys(entries, state.selectedHistoryKeys, entry, checked);
  render();
}

function toggleCurrentTranscriptBookmark() {
  const transcriptEntries = state.app?.state?.transcript ?? state.app?.state?.history ?? [];
  const currentCueId = state.app?.state?.currentCueId ?? null;
  const entry = transcriptEntries.find((candidate) => candidate.id === currentCueId);
  if (!entry) {
    showToast('No current transcript line to bookmark.');
    return;
  }

  toggleTranscriptBookmark(entry);
}

function toggleTranscriptBookmarkForCueId(cueId, sessionId = null) {
  if (sessionId && state.app?.state?.session?.sessionId !== sessionId) {
    return;
  }

  const transcriptEntries = state.app?.state?.transcript ?? state.app?.state?.history ?? [];
  const entry = transcriptEntries.find((candidate) => candidate.id === cueId);
  if (!entry) {
    showToast('No current transcript line to bookmark.');
    return;
  }

  toggleTranscriptBookmark(entry);
}

function toggleTranscriptBookmark(entry) {
  const bookmarkKey = buildTranscriptBookmarkKey(entry);
  const nextBookmarkedKeys = new Set(state.bookmarkedTranscriptKeys);
  if (nextBookmarkedKeys.has(bookmarkKey)) {
    nextBookmarkedKeys.delete(bookmarkKey);
  } else {
    nextBookmarkedKeys.add(bookmarkKey);
  }

  state.bookmarkedTranscriptKeys = nextBookmarkedKeys;
  saveTranscriptBookmarks(state.bookmarkedTranscriptKeys);
  render();
}

function loadTranscriptBookmarks() {
  try {
    const raw = localStorage.getItem(TRANSCRIPT_BOOKMARKS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed.filter((value) => typeof value === 'string' && value));
  } catch {
    return new Set();
  }
}

function saveTranscriptBookmarks(bookmarkedKeys) {
  try {
    localStorage.setItem(TRANSCRIPT_BOOKMARKS_STORAGE_KEY, JSON.stringify([...bookmarkedKeys]));
  } catch {
    showToast('Bookmarks could not be saved in this browser.', 'error');
  }
}

function renderToasts() {
  elements.toastRegion.innerHTML = '';

  state.toasts.forEach((toast) => {
    const item = document.createElement('div');
    item.className = `toast toast-${toast.kind}`;
    item.setAttribute('role', toast.kind === 'error' ? 'alert' : 'status');
    item.textContent = toast.message;
    elements.toastRegion.append(item);
  });
}

function showToast(message, kind = 'success') {
  if (typeof message !== 'string') {
    return;
  }

  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    return;
  }

  const toast = {
    id: ++nextToastId,
    kind: kind === 'error' ? 'error' : 'success',
    message: trimmedMessage,
  };

  state.toasts = [...state.toasts, toast];
  renderToasts();

  window.setTimeout(() => {
    dismissToast(toast.id);
  }, 3200);
}

function dismissToast(toastId) {
  const nextToasts = state.toasts.filter((toast) => toast.id !== toastId);
  if (nextToasts.length === state.toasts.length) {
    return;
  }

  state.toasts = nextToasts;
  renderToasts();
}

function openSettingsModal() {
  state.settingsModalReturnFocusEl =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.settingsModalOpen = true;
  state.settingsSaveError = '';
  elements.settingsCaptureAdvanced.open = false;
  hydrateSettingsForm();
  render();
  focusSettingsModal();
  if (shouldRefreshSettingsOptions(state.settingsModalOpen, state.settingsOptionsLoading)) {
    void refreshSettingsOptions(
      elements.settingsAnkiNoteType.value || state.app?.config?.settings?.anki?.noteType,
      elements.settingsAnkiDeck.value || state.app?.config?.settings?.anki?.deck,
    );
  }
}

function closeSettingsModal() {
  if (state.settingsSaving) {
    return;
  }

  state.settingsModalOpen = false;
  state.settingsSaveError = '';
  render();

  const returnTarget =
    state.settingsModalReturnFocusEl instanceof HTMLElement ? state.settingsModalReturnFocusEl : elements.settingsButton;
  state.settingsModalReturnFocusEl = null;
  window.requestAnimationFrame(() => {
    returnTarget?.focus();
  });
}

function handleDocumentKeydown(event) {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (shouldHandleTranscriptBookmarkShortcut({
    key: event.key,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    isComposing: event.isComposing,
    settingsModalOpen: state.settingsModalOpen,
    targetTagName: target?.tagName,
    targetIsContentEditable: Boolean(target?.isContentEditable),
  })) {
    event.preventDefault();
    toggleCurrentTranscriptBookmark();
    return;
  }

  if (!state.settingsModalOpen) {
    return;
  }

  if (event.key === 'Escape' && !state.settingsSaving) {
    event.preventDefault();
    closeSettingsModal();
    return;
  }

  if (event.key === 'Tab') {
    trapSettingsModalFocus(event);
  }
}

function focusSettingsModal() {
  window.requestAnimationFrame(() => {
    if (!state.settingsModalOpen) {
      return;
    }

    const [firstFocusable] = getSettingsFocusableElements();
    (firstFocusable ?? elements.settingsPanel)?.focus();
  });
}

function trapSettingsModalFocus(event) {
  const focusable = getSettingsFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    elements.settingsPanel.focus();
    return;
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const firstFocusable = focusable[0];
  const lastFocusable = focusable[focusable.length - 1];

  if (!activeElement || !elements.settingsPanel.contains(activeElement)) {
    event.preventDefault();
    firstFocusable.focus();
    return;
  }

  if (event.shiftKey && activeElement === firstFocusable) {
    event.preventDefault();
    lastFocusable.focus();
    return;
  }

  if (!event.shiftKey && activeElement === lastFocusable) {
    event.preventDefault();
    firstFocusable.focus();
  }
}

function getSettingsFocusableElements() {
  return [...elements.settingsPanel.querySelectorAll(SETTINGS_FOCUSABLE_SELECTOR)].filter((element) => {
    if (!(element instanceof HTMLElement) || element.hidden || element.closest('[hidden]')) {
      return false;
    }

    const closedDetails = element.closest('details:not([open])');
    if (closedDetails && element.tagName !== 'SUMMARY') {
      return false;
    }

    return true;
  });
}

function hydrateSettingsForm() {
  const settings = state.app?.config?.settings;
  if (!settings) {
    return;
  }

  populateSelect(elements.settingsAnkiDeck, [], settings.anki.deck, { allowBlank: false });
  populateSelect(elements.settingsAnkiNoteType, [], settings.anki.noteType, { allowBlank: false });
  populateFieldSelects([], settings.anki.fields, settings.learning?.knownWordField ?? '');

  elements.settingsAnkiExtraQuery.value = settings.anki.extraQuery ?? '';
  elements.settingsAnkiFilenameTemplate.value = settings.anki.filenameTemplate ?? '';
  elements.settingsRuntimeCaptureAudio.checked = Boolean(settings.runtime.captureAudio);
  elements.settingsRuntimeCaptureImage.checked = Boolean(settings.runtime.captureImage);
  elements.settingsCaptureAudioPrePaddingMs.value = String(settings.capture.audioPrePaddingMs ?? 0);
  elements.settingsCaptureAudioPostPaddingMs.value = String(settings.capture.audioPostPaddingMs ?? 0);
  elements.settingsCaptureAudioFormat.value = settings.capture.audioFormat ?? '';
  elements.settingsCaptureAudioCodec.value = settings.capture.audioCodec ?? '';
  elements.settingsCaptureAudioBitrate.value = settings.capture.audioBitrate ?? '';
  elements.settingsCaptureImageFormat.value = settings.capture.imageFormat ?? '';
  elements.settingsCaptureImageQuality.value = String(settings.capture.imageQuality ?? 0);
  elements.settingsCaptureImageMaxWidth.value = String(settings.capture.imageMaxWidth ?? 0);
  elements.settingsCaptureImageMaxHeight.value = String(settings.capture.imageMaxHeight ?? 0);
  elements.settingsCaptureImageIncludeSubtitles.checked = Boolean(settings.capture.imageIncludeSubtitles);
  elements.settingsIPlusOneEnabled.checked = Boolean(settings.learning?.iPlusOneEnabled);
  syncSubtitleCardFontPicker(settings.appearance.subtitleCardFontFamily ?? '');
  elements.settingsAppearanceSubtitleCardFontSizePx.value = settings.appearance.subtitleCardFontSizePx
    ? String(settings.appearance.subtitleCardFontSizePx)
    : '';
}

async function refreshSettingsOptions(noteType, deck) {
  const requestId = ++state.settingsRequestId;
  state.settingsOptionsLoading = true;
  state.settingsOptionsError = '';
  render();

  try {
    const search = new URLSearchParams();
    if (noteType) {
      search.set('noteType', noteType);
    }
    if (deck) {
      search.set('deck', deck);
    }

    const response = await fetch(`/api/settings/options?${search.toString()}`);
    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.message ?? `Request failed with status ${response.status}.`);
    }

    if (requestId !== state.settingsRequestId) {
      return;
    }

    state.settingsOptions = payload.options ?? {
      decks: [],
      noteTypes: [],
      noteFields: [],
      fonts: [],
      selectedDeck: '',
      selectedNoteType: '',
    };
    populateSelect(
      elements.settingsAnkiNoteType,
      state.settingsOptions.noteTypes,
      state.settingsOptions.selectedNoteType ||
        elements.settingsAnkiNoteType.value ||
        noteType ||
        state.app?.config?.settings?.anki?.noteType,
      {
        allowBlank: false,
        preserveUnknown: false,
      },
    );
    populateSelect(
      elements.settingsAnkiDeck,
      state.settingsOptions.decks,
      state.settingsOptions.selectedDeck || elements.settingsAnkiDeck.value || deck || state.app?.config?.settings?.anki?.deck,
      {
        allowBlank: false,
        preserveUnknown: false,
      },
    );
    populateFieldSelects(state.settingsOptions.noteFields, {
      subtitle: elements.settingsFieldSubtitle.value,
      knownWord: elements.settingsKnownWordField.value,
      audio: elements.settingsFieldAudio.value,
      image: elements.settingsFieldImage.value,
      source: elements.settingsFieldSource.value,
      time: elements.settingsFieldTime.value,
      filename: elements.settingsFieldFilename.value,
    });
    syncSubtitleCardFontPicker(getCurrentSubtitleCardFontFamilyValue());
  } catch (error) {
    if (requestId !== state.settingsRequestId) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    state.settingsOptionsError = message;
  } finally {
    if (requestId === state.settingsRequestId) {
      state.settingsOptionsLoading = false;
      render();
    }
  }
}

async function saveSettings() {
  state.settingsSaveError = '';
  state.settingsSaving = true;
  render();

  try {
    const payload = collectSettingsPayload();
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responsePayload = await response.json();
    if (!response.ok || responsePayload?.success === false) {
      throw new Error(responsePayload?.message ?? `Request failed with status ${response.status}.`);
    }

    state.app = responsePayload;
    state.settingsModalOpen = false;
    elements.settingsCaptureAdvanced.open = false;
    hydrateSettingsForm();
  } catch (error) {
    state.settingsSaveError = error instanceof Error ? error.message : String(error);
  } finally {
    state.settingsSaving = false;
    render();
    if (!state.settingsModalOpen) {
      const returnTarget =
        state.settingsModalReturnFocusEl instanceof HTMLElement ? state.settingsModalReturnFocusEl : elements.settingsButton;
      state.settingsModalReturnFocusEl = null;
      window.requestAnimationFrame(() => {
        returnTarget?.focus();
      });
    }
  }
}

function collectSettingsPayload() {
  return {
    anki: {
      deck: elements.settingsAnkiDeck.value.trim(),
      noteType: elements.settingsAnkiNoteType.value.trim(),
      extraQuery: elements.settingsAnkiExtraQuery.value.trim(),
      fields: {
        subtitle: elements.settingsFieldSubtitle.value.trim(),
        audio: elements.settingsFieldAudio.value.trim(),
        image: elements.settingsFieldImage.value.trim(),
        source: elements.settingsFieldSource.value.trim(),
        time: elements.settingsFieldTime.value.trim(),
        filename: elements.settingsFieldFilename.value.trim(),
      },
      filenameTemplate: elements.settingsAnkiFilenameTemplate.value.trim(),
    },
    learning: {
      iPlusOneEnabled: elements.settingsIPlusOneEnabled.checked,
      knownWordField: elements.settingsKnownWordField.value.trim(),
    },
    capture: {
      audioPrePaddingMs: parseRequiredInteger(elements.settingsCaptureAudioPrePaddingMs, 'Audio pre-padding'),
      audioPostPaddingMs: parseRequiredInteger(elements.settingsCaptureAudioPostPaddingMs, 'Audio post-padding'),
      audioFormat: elements.settingsCaptureAudioFormat.value.trim(),
      audioCodec: elements.settingsCaptureAudioCodec.value.trim(),
      audioBitrate: elements.settingsCaptureAudioBitrate.value.trim(),
      imageFormat: elements.settingsCaptureImageFormat.value.trim(),
      imageQuality: parseRequiredInteger(elements.settingsCaptureImageQuality, 'Image quality'),
      imageMaxWidth: parseRequiredInteger(elements.settingsCaptureImageMaxWidth, 'Image max width'),
      imageMaxHeight: parseRequiredInteger(elements.settingsCaptureImageMaxHeight, 'Image max height'),
      imageIncludeSubtitles: elements.settingsCaptureImageIncludeSubtitles.checked,
    },
    runtime: {
      captureAudio: elements.settingsRuntimeCaptureAudio.checked,
      captureImage: elements.settingsRuntimeCaptureImage.checked,
    },
    appearance: {
      subtitleCardFontFamily: resolveFontSettingValue(
        elements.settingsAppearanceSubtitleCardFontFamilySelect.value,
        elements.settingsAppearanceSubtitleCardFontFamilyCustom.value,
      ),
      subtitleCardFontSizePx: Math.max(0, Math.floor(Number(elements.settingsAppearanceSubtitleCardFontSizePx.value) || 0)),
    },
  };
}

function applyAppearanceSettings() {
  const subtitleCardFontFamily = state.app?.config?.settings?.appearance?.subtitleCardFontFamily?.trim() ?? '';
  if (subtitleCardFontFamily) {
    document.documentElement.style.setProperty('--subtitle-card-font-family', subtitleCardFontFamily);
  } else {
    document.documentElement.style.removeProperty('--subtitle-card-font-family');
  }

  const subtitleCardFontSizePx = Number(state.app?.config?.settings?.appearance?.subtitleCardFontSizePx) || 0;
  if (subtitleCardFontSizePx > 0) {
    document.documentElement.style.setProperty('--subtitle-card-font-size', `${subtitleCardFontSizePx}px`);
  } else {
    document.documentElement.style.removeProperty('--subtitle-card-font-size');
  }
}

function syncStickyLayout() {
  const heroHeight = elements.hero instanceof HTMLElement ? Math.ceil(elements.hero.offsetHeight) : 0;
  document.documentElement.style.setProperty('--hero-sticky-height', `${heroHeight}px`);
}

function syncCurrentCueScroll(currentCueId) {
  if (!currentCueId) {
    return;
  }

  const controls = state.renderedCueElements.get(currentCueId);
  if (!controls?.item) {
    return;
  }

  ensureAutoScrollListeners();
  state.autoScrollPausedByUser = false;

  const targetScrollTop = computeFollowTargetForItem(controls.item);
  if (targetScrollTop == null) {
    return;
  }

  if (prefersReducedMotion()) {
    stopAutoScrollLoop();
    state.autoScrollTargetY = null;
    window.scrollTo(0, targetScrollTop);
    return;
  }

  state.autoScrollTargetY = targetScrollTop;
  startAutoScrollLoop();
}

function computeFollowTargetForItem(item) {
  const rect = item.getBoundingClientRect();
  const styles = window.getComputedStyle(document.documentElement);
  const stickyHeaderHeight = parseCssLength(styles.getPropertyValue('--hero-sticky-height'));
  const stickyTopGap = parseCssLength(styles.getPropertyValue('--sticky-top-gap'));
  return computeTranscriptFollowScrollTarget({
    itemTop: rect.top,
    itemBottom: rect.bottom,
    viewportHeight: window.innerHeight,
    currentScrollTop: window.scrollY,
    documentHeight: document.documentElement.scrollHeight,
    stickyHeaderHeight,
    stickyTopGap,
  });
}

function startAutoScrollLoop() {
  if (state.autoScrollLoopId !== null) {
    return;
  }
  state.autoScrollLastTimestamp = null;
  state.autoScrollLoopId = window.requestAnimationFrame(stepAutoScrollLoop);
}

function stopAutoScrollLoop() {
  if (state.autoScrollLoopId !== null) {
    window.cancelAnimationFrame(state.autoScrollLoopId);
    state.autoScrollLoopId = null;
  }
  state.autoScrollLastTimestamp = null;
}

function stepAutoScrollLoop(timestamp) {
  state.autoScrollLoopId = null;

  if (state.autoScrollPausedByUser || state.autoScrollTargetY == null) {
    state.autoScrollLastTimestamp = null;
    return;
  }

  const previousTimestamp = state.autoScrollLastTimestamp;
  state.autoScrollLastTimestamp = timestamp;

  if (previousTimestamp == null) {
    state.autoScrollLoopId = window.requestAnimationFrame(stepAutoScrollLoop);
    return;
  }

  const dtSeconds = Math.min((timestamp - previousTimestamp) / 1000, AUTO_SCROLL_MAX_FRAME_DT_S);
  const currentY = window.scrollY;
  const target = state.autoScrollTargetY;
  const delta = target - currentY;

  if (Math.abs(delta) < AUTO_SCROLL_CONVERGENCE_PX) {
    window.scrollTo(0, target);
    state.autoScrollTargetY = null;
    state.autoScrollLastTimestamp = null;
    return;
  }

  const alpha = 1 - Math.exp(-dtSeconds / AUTO_SCROLL_TIME_CONSTANT_S);
  window.scrollTo(0, currentY + delta * alpha);
  state.autoScrollLoopId = window.requestAnimationFrame(stepAutoScrollLoop);
}

function ensureAutoScrollListeners() {
  if (state.autoScrollListenersAttached) {
    return;
  }
  state.autoScrollListenersAttached = true;

  const handleUserScrollIntent = () => {
    state.autoScrollPausedByUser = true;
    state.autoScrollTargetY = null;
    stopAutoScrollLoop();
  };

  window.addEventListener('wheel', handleUserScrollIntent, { passive: true });
  window.addEventListener('touchstart', handleUserScrollIntent, { passive: true });
  window.addEventListener('keydown', (event) => {
    const scrollKeys = ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar'];
    if (scrollKeys.includes(event.key)) {
      handleUserScrollIntent();
    }
  });
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function parseCssLength(value) {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseRequiredInteger(input, label) {
  const value = Number.parseInt(input.value, 10);
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be a whole number.`);
  }

  return value;
}

function populateFieldSelects(noteFields, currentFields, currentKnownWordField = currentFields?.knownWord ?? '') {
  const preserveUnknown = noteFields.length === 0;

  populateSelect(elements.settingsFieldSubtitle, noteFields, currentFields.subtitle ?? '', {
    allowBlank: false,
    preserveUnknown,
  });
  populateSelect(elements.settingsKnownWordField, noteFields, currentKnownWordField ?? '', {
    allowBlank: true,
    blankLabel: 'Choose field',
    preserveUnknown,
  });
  populateSelect(elements.settingsFieldAudio, noteFields, currentFields.audio ?? '', {
    allowBlank: true,
    blankLabel: 'Disabled / empty',
    preserveUnknown,
  });
  populateSelect(elements.settingsFieldImage, noteFields, currentFields.image ?? '', {
    allowBlank: true,
    blankLabel: 'Disabled / empty',
    preserveUnknown,
  });
  populateSelect(elements.settingsFieldSource, noteFields, currentFields.source ?? '', {
    allowBlank: true,
    blankLabel: 'Not set',
    preserveUnknown,
  });
  populateSelect(elements.settingsFieldTime, noteFields, currentFields.time ?? '', {
    allowBlank: true,
    blankLabel: 'Not set',
    preserveUnknown,
  });
  populateSelect(elements.settingsFieldFilename, noteFields, currentFields.filename ?? '', {
    allowBlank: true,
    blankLabel: 'Not set',
    preserveUnknown,
  });
}

function syncSubtitleCardFontPicker(currentValue) {
  const pickerState = resolveFontPickerState(state.settingsOptions.fonts, currentValue);
  populateSelect(
    elements.settingsAppearanceSubtitleCardFontFamilySelect,
    state.settingsOptions.fonts,
    pickerState.selectValue,
    {
      allowBlank: true,
      blankLabel: 'Default app font',
      preserveUnknown: false,
      extraOptions: [
        {
          value: CUSTOM_FONT_OPTION_VALUE,
          label: 'Custom value',
        },
      ],
    },
  );
  elements.settingsAppearanceSubtitleCardFontFamilyCustom.value = pickerState.customValue;
  syncSubtitleCardFontCustomInputVisibility(pickerState.showCustomInput);
}

function syncSubtitleCardFontCustomInputVisibility(forceVisible = null) {
  const showCustomInput =
    typeof forceVisible === 'boolean'
      ? forceVisible
      : elements.settingsAppearanceSubtitleCardFontFamilySelect.value === CUSTOM_FONT_OPTION_VALUE;
  elements.settingsAppearanceSubtitleCardFontFamilyCustomField.hidden = !showCustomInput;
}

function getCurrentSubtitleCardFontFamilyValue() {
  if (!elements.settingsAppearanceSubtitleCardFontFamilySelect.options.length) {
    return state.app?.config?.settings?.appearance?.subtitleCardFontFamily ?? '';
  }

  return resolveFontSettingValue(
    elements.settingsAppearanceSubtitleCardFontFamilySelect.value,
    elements.settingsAppearanceSubtitleCardFontFamilyCustom.value,
  );
}

function populateSelect(select, options, currentValue, config = {}) {
  const values = [...new Set(options.filter(Boolean))];
  if (config.preserveUnknown !== false && currentValue && !values.includes(currentValue)) {
    values.unshift(currentValue);
  }
  const extraOptions = Array.isArray(config.extraOptions)
    ? config.extraOptions.filter((option) => option && typeof option.value === 'string')
    : [];
  const selectableValues = new Set(values);

  select.innerHTML = '';

  if (config.allowBlank) {
    select.append(buildOption('', config.blankLabel ?? 'Not set'));
    selectableValues.add('');
  }

  values.forEach((value) => {
    select.append(buildOption(value, value));
  });
  extraOptions.forEach((option) => {
    if (selectableValues.has(option.value)) {
      return;
    }

    select.append(buildOption(option.value, option.label ?? option.value));
    selectableValues.add(option.value);
  });

  const selectedValue = selectableValues.has(currentValue)
    ? currentValue
    : (config.allowBlank ? '' : (values[0] ?? extraOptions[0]?.value ?? ''));
  select.value = selectedValue;
  return selectedValue;
}

function buildOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
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

function renderEmptyTranscriptState(transcriptState) {
  const emptyState = buildTranscriptEmptyState(transcriptState);
  state.renderedCueElements = new Map();
  elements.historyList.innerHTML = '';

  const item = document.createElement('article');
  item.className = 'history-empty-state';
  item.dataset.transcriptStatus = transcriptState?.transcriptStatus ?? 'unavailable';

  const title = document.createElement('h2');
  title.className = 'history-empty-title';
  title.textContent = emptyState.title;

  const copy = document.createElement('p');
  copy.className = 'history-empty-copy';
  copy.textContent = emptyState.message;

  item.append(title, copy);
  elements.historyList.append(item);
}

function renderBookmarkedTranscriptEmptyState() {
  state.renderedCueElements = new Map();
  elements.historyList.innerHTML = '';

  const item = document.createElement('article');
  item.className = 'history-empty-state';
  item.dataset.transcriptStatus = 'bookmarks-empty';

  const title = document.createElement('h2');
  title.className = 'history-empty-title';
  title.textContent = 'No bookmarked lines';

  const copy = document.createElement('p');
  copy.className = 'history-empty-copy';
  copy.textContent = 'Bookmark transcript lines to show them here.';

  item.append(title, copy);
  elements.historyList.append(item);
}

function rebuildTranscriptList(entries) {
  state.renderedCueElements = new Map();
  elements.historyList.innerHTML = '';

  entries.forEach((entry) => {
    const item = document.createElement('article');
    item.className = 'history-item';
    item.dataset.entryKey = buildHistoryEntryKey(entry);
    item.dataset.cueId = entry.id;

    const head = document.createElement('div');
    head.className = 'history-item-head';

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = formatRange(entry.startMs, entry.endMs);

    const checkboxLabel = document.createElement('label');
    checkboxLabel.className = 'history-select';
    checkboxLabel.title = 'Select subtitle line';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Select subtitle line: ${entry.text}`);
    checkbox.addEventListener('change', () => {
      const transcriptEntries = state.app?.state?.transcript ?? state.app?.state?.history ?? [];
      applyHistorySelectionToggle(transcriptEntries, entry, checkbox.checked);
    });

    const checkboxMark = document.createElement('span');
    checkboxMark.className = 'history-select-mark';
    checkboxMark.append(buildIcon('check'));

    checkboxLabel.append(checkbox, checkboxMark);
    head.append(checkboxLabel);

    const content = document.createElement('div');
    content.className = 'history-content';

    const textRow = document.createElement('div');
    textRow.className = 'history-text-row';
    const text = document.createElement('div');
    text.className = 'history-text';
    const unknownWords = entry.learning?.iPlusOne ? (entry.learning?.unknownWords ?? []) : [];
    appendTranscriptText(text, entry.text, unknownWords);
    textRow.append(text);

    if (entry.learning?.iPlusOne && unknownWords.length === 1) {
      const badge = document.createElement('span');
      badge.className = 'i-plus-one-badge';
      badge.textContent = 'i+1';
      badge.title = `Unknown word: ${unknownWords[0]}`;
      textRow.append(badge);
    }

    content.append(textRow, meta);

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const bookmarkButton = buildTranscriptBookmarkButton(entry);
    const goToButton = buildHistoryActionButton('Go to', 'go-to', entry, 'play');
    const mineButton = buildHistoryActionButton('Mine', 'mine', entry, 'pickaxe');

    actions.append(bookmarkButton, goToButton, mineButton);
    item.append(head, content, actions);
    elements.historyList.append(item);
    state.renderedCueElements.set(entry.id, {
      item,
      checkbox,
      bookmarkButton,
      goToButton,
      mineButton,
    });
  });
}

function appendTranscriptText(container, text, unknownWords) {
  for (const part of buildHighlightedTranscriptParts(text, unknownWords)) {
    if (!part.unknown) {
      container.append(document.createTextNode(part.text));
      continue;
    }

    const mark = document.createElement('mark');
    mark.className = 'unknown-word-highlight';
    mark.textContent = part.text;
    mark.title = 'Unknown word';
    container.append(mark);
  }
}

function updateTranscriptItemUi(renderedEntries, currentCueId, allEntries = renderedEntries, actionsEnabled = true) {
  renderedEntries.forEach((entry) => {
    const controls = state.renderedCueElements.get(entry.id);
    if (!controls) {
      return;
    }

    const uiState = computeTranscriptItemUiState(
      allEntries,
      state.selectedHistoryKeys,
      state.pendingActions,
      currentCueId,
      entry,
      state.bookmarkedTranscriptKeys,
      actionsEnabled,
    );
    controls.item.classList.toggle('history-item-active', uiState.active);
    controls.item.classList.toggle('history-item-selected', uiState.selected);
    controls.item.classList.toggle('history-item-bookmarked', uiState.bookmarked);
    controls.item.setAttribute('aria-current', uiState.active ? 'true' : 'false');
    controls.checkbox.checked = uiState.selected;
    controls.checkbox.disabled = uiState.checkboxDisabled;
    controls.checkbox.parentElement?.classList.toggle('history-select-disabled', uiState.checkboxDisabled);
    controls.bookmarkButton.classList.toggle('history-bookmark-button-active', uiState.bookmarked);
    controls.bookmarkButton.setAttribute('aria-pressed', String(uiState.bookmarked));
    controls.bookmarkButton.setAttribute(
      'aria-label',
      `${uiState.bookmarked ? 'Remove bookmark' : 'Bookmark'}: ${entry.text}`,
    );
    controls.bookmarkButton.title = uiState.bookmarked ? 'Remove bookmark' : 'Bookmark';
    controls.goToButton.disabled = uiState.goToDisabled;
    controls.mineButton.disabled = uiState.mineDisabled;
  });
}

function buildIcon(name) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.classList.add('lucide-icon');
  icon.setAttribute('aria-hidden', 'true');

  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  icon.append(use);
  return icon;
}
