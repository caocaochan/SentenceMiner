import {
  buildBatchHistoryMineRequest,
  buildHistoryEntryKey,
  isHistorySelectionToggleAllowed,
  reconcileSelectedHistoryKeys,
  toggleSelectedHistoryKeys,
} from './history-selection.js';

const state = {
  connection: 'connecting',
  app: null,
  autoScroll: true,
  pendingActions: new Set(),
  selectedHistoryKeys: new Set(),
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
};
const STATE_POLL_INTERVAL_MS = 2000;
let reconnectTimerId = null;
let statePollIntervalId = null;

const elements = {
  connectionPill: document.getElementById('connection-pill'),
  fileName: document.getElementById('file-name'),
  currentTime: document.getElementById('current-time'),
  currentSubtitle: document.getElementById('current-subtitle'),
  historyCount: document.getElementById('history-count'),
  historySelectionCount: document.getElementById('history-selection-count'),
  historyList: document.getElementById('history-list'),
  historyMineSelected: document.getElementById('history-mine-selected'),
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
};

elements.historyList.addEventListener('scroll', () => {
  const threshold = 40;
  state.autoScroll = elements.historyList.scrollTop < threshold;
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

bootstrap();

async function bootstrap() {
  await refreshState({ suppressErrors: true });
  connectWebSocket();
  startStatePolling();
  void refreshSettingsOptions(state.app?.config?.settings?.anki?.noteType, state.app?.config?.settings?.anki?.deck);
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
  renderTranscript();
  renderSettingsUi();
}

function renderTranscript() {
  const transcriptState = state.app?.state ?? { session: null, currentSubtitle: null, history: [] };
  const currentSubtitle = transcriptState.currentSubtitle;
  const historyEntries = transcriptState.history ?? [];
  state.selectedHistoryKeys = reconcileSelectedHistoryKeys(state.selectedHistoryKeys, historyEntries);
  const selectedEntries = historyEntries.filter((entry) => state.selectedHistoryKeys.has(buildHistoryEntryKey(entry)));
  const history = [...historyEntries].reverse();

  elements.connectionPill.textContent =
    state.connection === 'live' ? 'Live' : state.connection === 'offline' ? 'Reconnecting' : 'Connecting';
  elements.connectionPill.className = `pill ${state.connection === 'live' ? 'pill-success' : 'pill-muted'}`;
  elements.fileName.textContent = transcriptState.session?.filePath ?? 'No file loaded';
  elements.currentTime.textContent = currentSubtitle ? formatRange(currentSubtitle.startMs, currentSubtitle.endMs) : '--:--.--';
  elements.currentSubtitle.textContent = currentSubtitle?.text ?? 'Waiting for subtitles from mpv…';
  elements.currentSubtitle.className = `subtitle-display ${currentSubtitle?.text ? '' : 'empty'}`;
  elements.historyCount.textContent = `${history.length} ${history.length === 1 ? 'line' : 'lines'}`;
  elements.historySelectionCount.textContent = `${selectedEntries.length} selected`;
  elements.historyMineSelected.disabled =
    selectedEntries.length === 0 || isAnyBatchHistoryActionPending('mine-selected');

  const previousScrollHeight = elements.historyList.scrollHeight;
  const previousScrollTop = elements.historyList.scrollTop;

  elements.historyList.innerHTML = '';
  history.forEach((entry, index) => {
    const item = document.createElement('article');
    item.className = 'history-item';
    if (currentSubtitle && isSameSubtitle(currentSubtitle, entry)) {
      item.classList.add('history-item-active');
    }
    const entryKey = buildHistoryEntryKey(entry);
    if (state.selectedHistoryKeys.has(entryKey)) {
      item.classList.add('history-item-selected');
    }

    const head = document.createElement('div');
    head.className = 'history-item-head';

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = formatRange(entry.startMs, entry.endMs);

    const checkboxLabel = document.createElement('label');
    checkboxLabel.className = 'history-checkbox';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedHistoryKeys.has(entryKey);
    checkbox.disabled = !isHistorySelectionToggleAllowed(historyEntries, state.selectedHistoryKeys, entry, checkbox.checked);
    checkbox.setAttribute('aria-label', `Select subtitle line: ${entry.text}`);
    checkbox.addEventListener('change', () => {
      applyHistorySelectionToggle(historyEntries, entry, checkbox.checked);
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
  const historyEntries = state.app?.state?.history ?? [];
  const request = buildBatchHistoryMineRequest(historyEntries, state.selectedHistoryKeys);
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

function isSameSubtitle(a, b) {
  return a.sessionId === b.sessionId && a.startMs === b.startMs && a.endMs === b.endMs && a.text === b.text;
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
  };
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
