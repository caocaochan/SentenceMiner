import {
  buildBatchHistoryMineRequest,
  buildHistoryEntryKey,
  reconcileSelectedHistoryKeys,
  toggleSelectedHistoryKeys,
} from './history-selection.js';
import {
  buildTranscriptStructureSignature,
  computeTranscriptItemUiState,
  shouldRebuildTranscriptList,
} from './transcript-render.js';

const state = {
  connection: 'connecting',
  app: null,
  pendingActions: new Set(),
  selectedHistoryKeys: new Set(),
  toasts: [],
  settingsModalOpen: false,
  settingsOptions: {
    decks: [],
    noteTypes: [],
    noteFields: [],
  },
  settingsOptionsLoading: false,
  settingsOptionsError: '',
  settingsSaving: false,
  settingsSaveError: '',
  settingsRequestId: 0,
  renderedTranscriptSignature: '',
  renderedCueElements: new Map(),
  autoScrollFrameId: null,
  lastScrolledCueId: null,
};
const STATE_POLL_INTERVAL_MS = 2000;
let reconnectTimerId = null;
let statePollIntervalId = null;
let nextToastId = 0;

const elements = {
  hero: document.querySelector('.hero'),
  connectionPill: document.getElementById('connection-pill'),
  fileName: document.getElementById('file-name'),
  historyCount: document.getElementById('history-count'),
  transcriptStatus: document.getElementById('transcript-status'),
  historySelectionCount: document.getElementById('history-selection-count'),
  historyList: document.getElementById('history-list'),
  historyMineSelected: document.getElementById('history-mine-selected'),
  toastRegion: document.getElementById('toast-region'),
  themeToggle: document.getElementById('theme-toggle'),
  settingsButton: document.getElementById('settings-button'),
  settingsModal: document.getElementById('settings-modal'),
  settingsBackdrop: document.getElementById('settings-backdrop'),
  settingsClose: document.getElementById('settings-close'),
  settingsCancel: document.getElementById('settings-cancel'),
  settingsSave: document.getElementById('settings-save'),
  settingsForm: document.getElementById('settings-form'),
  settingsOptionsStatus: document.getElementById('settings-options-status'),
  settingsError: document.getElementById('settings-error'),
  settingsAnkiDeck: document.getElementById('settings-anki-deck'),
  settingsAnkiNoteType: document.getElementById('settings-anki-note-type'),
  settingsAnkiExtraQuery: document.getElementById('settings-anki-extra-query'),
  settingsFieldSubtitle: document.getElementById('settings-field-subtitle'),
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
  settingsAppearanceSubtitleCardFontFamily: document.getElementById('settings-appearance-subtitle-card-font-family'),
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
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.settingsModalOpen && !state.settingsSaving) {
    closeSettingsModal();
  }
});

initTheme();
bootstrap();

function initTheme() {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
}

async function bootstrap() {
  initializeStickyLayout();
  await refreshState({ suppressErrors: true });
  connectWebSocket();
  startStatePolling();
  void refreshSettingsOptions(state.app?.config?.settings?.anki?.noteType, state.app?.config?.settings?.anki?.deck);
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

    if (message.type === 'toast') {
      showToast(message.payload?.message, message.payload?.kind);
    }
  });

  socket.addEventListener('close', () => {
    state.connection = 'offline';
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
  if (statePollIntervalId !== null) {
    return;
  }

  statePollIntervalId = window.setInterval(() => {
    void refreshState({ suppressErrors: true });
  }, STATE_POLL_INTERVAL_MS);
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
  state.selectedHistoryKeys = reconcileSelectedHistoryKeys(state.selectedHistoryKeys, transcriptEntries);
  const selectedEntries = transcriptEntries.filter((entry) => state.selectedHistoryKeys.has(buildHistoryEntryKey(entry)));

  elements.connectionPill.textContent =
    state.connection === 'live' ? 'Live' : state.connection === 'offline' ? 'Reconnecting' : 'Connecting';
  elements.connectionPill.className = `pill ${state.connection === 'live' ? 'pill-success' : 'pill-muted'}`;
  elements.fileName.textContent = transcriptState.session?.filePath ?? 'No file loaded';
  elements.historyCount.textContent = `${transcriptEntries.length} ${transcriptEntries.length === 1 ? 'line' : 'lines'}`;
  elements.transcriptStatus.textContent = buildTranscriptStatusLabel(transcriptState);
  elements.transcriptStatus.hidden = !elements.transcriptStatus.textContent;
  elements.historySelectionCount.textContent = `${selectedEntries.length} selected`;
  elements.historyMineSelected.disabled =
    selectedEntries.length === 0 || isAnyBatchHistoryActionPending('mine-selected');

  if (shouldRebuildTranscriptList(state.renderedTranscriptSignature, transcriptEntries)) {
    rebuildTranscriptList(transcriptEntries);
    state.renderedTranscriptSignature = buildTranscriptStructureSignature(transcriptEntries);
    state.lastScrolledCueId = null;
  }

  updateTranscriptItemUi(transcriptEntries, transcriptState.currentCueId);
  if (transcriptState.currentCueId !== state.lastScrolledCueId) {
    state.lastScrolledCueId = transcriptState.currentCueId;
    syncCurrentCueScroll(transcriptState.currentCueId);
  }
}

function renderSettingsUi() {
  elements.settingsModal.hidden = !state.settingsModalOpen;
  elements.settingsButton.setAttribute('aria-expanded', String(state.settingsModalOpen));
  document.body.classList.toggle('modal-open', state.settingsModalOpen);

  const optionsStatus = state.settingsOptionsLoading
    ? 'Loading decks, note types, and note fields from Anki…'
    : state.settingsOptionsError || 'Settings are saved to sentenceminer.conf and applied immediately.';

  elements.settingsOptionsStatus.textContent = optionsStatus;
  elements.settingsOptionsStatus.className = `settings-status ${state.settingsOptionsError ? 'settings-status-warning' : 'muted'}`;
  elements.settingsError.textContent = state.settingsSaveError;
  elements.settingsError.hidden = !state.settingsSaveError;

  elements.settingsSave.disabled = state.settingsSaving;
  elements.settingsSave.textContent = state.settingsSaving ? 'Saving…' : 'Save settings';
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

function renderToasts() {
  elements.toastRegion.innerHTML = '';

  state.toasts.forEach((toast) => {
    const item = document.createElement('div');
    item.className = `toast toast-${toast.kind}`;
    item.setAttribute('role', 'status');
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
  state.settingsModalOpen = true;
  state.settingsSaveError = '';
  hydrateSettingsForm();
  render();
  void refreshSettingsOptions(
    elements.settingsAnkiNoteType.value || state.app?.config?.settings?.anki?.noteType,
    elements.settingsAnkiDeck.value || state.app?.config?.settings?.anki?.deck,
  );
}

function closeSettingsModal() {
  if (state.settingsSaving) {
    return;
  }

  state.settingsModalOpen = false;
  state.settingsSaveError = '';
  render();
}

function hydrateSettingsForm() {
  const settings = state.app?.config?.settings;
  if (!settings) {
    return;
  }

  populateSelect(elements.settingsAnkiDeck, [], settings.anki.deck, { allowBlank: false });
  populateSelect(elements.settingsAnkiNoteType, [], settings.anki.noteType, { allowBlank: false });
  populateFieldSelects([], settings.anki.fields);

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
  elements.settingsAppearanceSubtitleCardFontFamily.value = settings.appearance.subtitleCardFontFamily ?? '';
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
      audio: elements.settingsFieldAudio.value,
      image: elements.settingsFieldImage.value,
      source: elements.settingsFieldSource.value,
      time: elements.settingsFieldTime.value,
      filename: elements.settingsFieldFilename.value,
    });
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
    hydrateSettingsForm();
  } catch (error) {
    state.settingsSaveError = error instanceof Error ? error.message : String(error);
  } finally {
    state.settingsSaving = false;
    render();
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
      subtitleCardFontFamily: elements.settingsAppearanceSubtitleCardFontFamily.value.trim(),
    },
  };
}

function applyAppearanceSettings() {
  const subtitleCardFontFamily = state.app?.config?.settings?.appearance?.subtitleCardFontFamily?.trim() ?? '';
  if (subtitleCardFontFamily) {
    document.documentElement.style.setProperty('--subtitle-card-font-family', subtitleCardFontFamily);
    return;
  }

  document.documentElement.style.removeProperty('--subtitle-card-font-family');
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

  if (state.autoScrollFrameId !== null) {
    window.cancelAnimationFrame(state.autoScrollFrameId);
  }

  state.autoScrollFrameId = window.requestAnimationFrame(() => {
    state.autoScrollFrameId = null;
    centerTranscriptItemInViewport(controls.item);
  });
}

function centerTranscriptItemInViewport(item) {
  const rect = item.getBoundingClientRect();
  const itemCenterY = rect.top + (rect.height / 2);
  const viewportCenterY = window.innerHeight / 2;
  const scrollDelta = itemCenterY - viewportCenterY;

  if (Math.abs(scrollDelta) < 2) {
    return;
  }

  const maxScrollTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const targetScrollTop = clamp(window.scrollY + scrollDelta, 0, maxScrollTop);
  window.scrollTo({
    top: targetScrollTop,
    behavior: 'smooth',
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseRequiredInteger(input, label) {
  const value = Number.parseInt(input.value, 10);
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be a whole number.`);
  }

  return value;
}

function populateFieldSelects(noteFields, currentFields) {
  const preserveUnknown = noteFields.length === 0;

  populateSelect(elements.settingsFieldSubtitle, noteFields, currentFields.subtitle ?? '', {
    allowBlank: false,
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

function populateSelect(select, options, currentValue, config = {}) {
  const values = [...new Set(options.filter(Boolean))];
  if (config.preserveUnknown !== false && currentValue && !values.includes(currentValue)) {
    values.unshift(currentValue);
  }

  select.innerHTML = '';

  if (config.allowBlank) {
    select.append(buildOption('', config.blankLabel ?? 'Not set'));
  }

  values.forEach((value) => {
    select.append(buildOption(value, value));
  });

  const selectedValue = values.includes(currentValue)
    ? currentValue
    : (config.allowBlank ? '' : (values[0] ?? ''));
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

function buildTranscriptStatusLabel(transcriptState) {
  const status = transcriptState.transcriptStatus ?? 'unavailable';
  const message = transcriptState.transcriptMessage?.trim() ?? '';

  if (status === 'ready') {
    return message;
  }

  if (status === 'loading') {
    return message || 'Loading active subtitle track…';
  }

  if (status === 'error') {
    return message || 'The active subtitle track could not be loaded.';
  }

  return message || 'No active subtitle track is selected.';
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
    checkboxLabel.className = 'history-checkbox';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Select subtitle line: ${entry.text}`);
    checkbox.addEventListener('change', () => {
      const transcriptEntries = state.app?.state?.transcript ?? state.app?.state?.history ?? [];
      applyHistorySelectionToggle(transcriptEntries, entry, checkbox.checked);
    });

    const checkboxText = document.createElement('span');
    checkboxText.textContent = 'Select';

    checkboxLabel.append(checkbox, checkboxText);
    head.append(meta, checkboxLabel);

    const text = document.createElement('div');
    text.className = 'history-text';
    text.textContent = entry.text;

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const goToButton = buildHistoryActionButton('Go to', 'go-to', entry);
    const mineButton = buildHistoryActionButton('Mine', 'mine', entry);

    actions.append(goToButton, mineButton);
    item.append(head, text, actions);
    elements.historyList.append(item);
    state.renderedCueElements.set(entry.id, {
      item,
      checkbox,
      goToButton,
      mineButton,
    });
  });
}

function updateTranscriptItemUi(entries, currentCueId) {
  entries.forEach((entry) => {
    const controls = state.renderedCueElements.get(entry.id);
    if (!controls) {
      return;
    }

    const uiState = computeTranscriptItemUiState(entries, state.selectedHistoryKeys, state.pendingActions, currentCueId, entry);
    controls.item.classList.toggle('history-item-active', uiState.active);
    controls.item.classList.toggle('history-item-selected', uiState.selected);
    controls.item.setAttribute('aria-current', uiState.active ? 'true' : 'false');
    controls.checkbox.checked = uiState.selected;
    controls.checkbox.disabled = uiState.checkboxDisabled;
    controls.goToButton.disabled = uiState.goToDisabled;
    controls.mineButton.disabled = uiState.mineDisabled;
  });
}
