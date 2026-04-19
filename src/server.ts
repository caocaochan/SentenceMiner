import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import {
  InvalidAnkiMiningConfigError,
  NoMatchingCardError,
  listDeckNames,
  listModelFieldNames,
  listModelNames,
  mineToAnki,
} from './anki.ts';
import { mineHistoryEntry } from './history-mine.ts';
import { buildAppUrl } from './browser.ts';
import {
  applyEditableSettings,
  getEditableSettings,
  loadConfig,
  loadConfigFromPath,
  resolveAppRoot,
  resolveConfigPath,
  saveEditableSettings,
} from './config.ts';
import { parseParentPidArg, startParentWatch } from './parent-watch.ts';
import { PlayerCommandStore } from './player-command-store.ts';
import { loadSubtitleTranscript } from './subtitle-transcript.ts';
import { TranscriptStore } from './transcript-store.ts';
import type {
  AppConfig,
  EditableSettings,
  HistoryMineBatchPayload,
  HistoryMineRequest,
  MinePayload,
  ServerConfig,
  SessionPayload,
  SettingsOptions,
  StatePayload,
  SubtitleEventPayload,
  SubtitleTrackPayload,
} from './types.ts';
import { payloadKey } from './utils.ts';
import { WebSocketHub } from './ws.ts';

const APP_ROOT = resolveAppRoot();
const WEB_ROOT = path.join(APP_ROOT, 'web');

export interface ServerContext {
  config: AppConfig;
  configPath: string;
  transcriptStore: TranscriptStore;
  playerCommandStore: PlayerCommandStore;
  sockets: WebSocketHub;
  requestShutdown?: (reason: string) => void;
}

export type ListenResult = 'started' | 'already-running';

export async function main(): Promise<void> {
  const parentPid = parseParentPidArg(process.argv.slice(2));
  const configPath = resolveConfigPath(process.argv.slice(2));
  const config = await loadConfig();
  const transcriptStore = new TranscriptStore();
  const playerCommandStore = new PlayerCommandStore();
  const sockets = new WebSocketHub();
  const context: ServerContext = {
    config,
    configPath,
    transcriptStore,
    playerCommandStore,
    sockets,
  };

  const server = http.createServer(createRequestHandler(context));

  server.on('upgrade', (request, socket) => {
    if (request.url !== '/ws') {
      socket.destroy();
      return;
    }

    sockets.handleUpgrade(request, socket);
  });

  let stopParentWatch: (() => void) | undefined;
  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    stopParentWatch?.();
    sockets.destroyAll();

    server.close((error) => {
      if (error) {
        console.error(`SentenceMiner helper shutdown failed after ${reason}: ${error.stack ?? error.message}`);
        process.exit(1);
      }

      process.exit(0);
    });

    const forcedExitTimer = setTimeout(() => process.exit(0), 2000);
    forcedExitTimer.unref?.();
  };
  context.requestShutdown = shutdown;

  if (parentPid !== null) {
    stopParentWatch = startParentWatch(parentPid, () => {
      console.log(`SentenceMiner helper exiting because parent process ${parentPid} closed.`);
      shutdown('parent process exit');
    });
  }

  const appUrl = buildAppUrl(config.server);
  const listenResult = await listenForAppServer(server, config.server);
  if (listenResult === 'already-running') {
    console.log(`SentenceMiner helper is already running on ${appUrl}`);
    stopParentWatch?.();
    return;
  }

  console.log(`SentenceMiner helper listening on ${appUrl}`);
}

export async function listenForAppServer(server: http.Server, config: ServerConfig): Promise<ListenResult> {
  try {
    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        server.off('listening', handleListening);
        reject(error);
      };
      const handleListening = () => {
        server.off('error', handleError);
        resolve();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(config.port, config.host);
    });

    return 'started';
  } catch (error) {
    if (isAddressInUseError(error) && (await probeRunningHelper(config))) {
      return 'already-running';
    }

    throw error;
  }
}

export async function probeRunningHelper(config: ServerConfig): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  timeout.unref?.();

  try {
    const response = await fetch(new URL('/api/state', buildAppUrl(config)), {
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }

    const payload = await response.json();
    return Boolean(payload?.success === true && payload?.config && payload?.state);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE');
}

export function createRequestHandler(context: ServerContext) {
  return async (request: http.IncomingMessage, response: http.ServerResponse) => {
    try {
      await routeRequest(context, request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      if (statusCode >= 500) {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      }
      respondJson(response, statusCode, {
        success: false,
        message,
      });
    }
  };
}

export async function routeRequest(
  context: ServerContext,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? `${context.config.server.host}:${context.config.server.port}`}`,
  );

  if (method === 'GET' && url.pathname === '/api/state') {
    respondJson(response, 200, buildStatePayload(context.config, context.transcriptStore));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/settings/options') {
    respondJson(response, 200, {
      success: true,
      options: await getSettingsOptions(
        context.config,
        url.searchParams.get('deck')?.trim() || context.config.anki.deck,
        url.searchParams.get('noteType')?.trim() || context.config.anki.noteType,
      ),
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/settings') {
    const payload = await readJsonBody<unknown>(request);
    const settings = parseEditableSettingsPayload(payload);
    await validateEditableSettings(context.config, settings);
    await saveEditableSettings(context.configPath, settings);

    replaceConfig(context.config, applyEditableSettings(context.config, settings));
    broadcastState(context.config, context.transcriptStore, context.sockets);

    respondJson(response, 200, buildStatePayload(context.config, context.transcriptStore));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/session') {
    const payload = parseSessionPayload(await readJsonBody<unknown>(request));
    if (payload.action === 'start') {
      await refreshConfigFromDisk(context);
    }
    context.playerCommandStore.clearAll();
    if (payload.action === 'start') {
      context.transcriptStore.startSession(payload);
      broadcastState(context.config, context.transcriptStore, context.sockets);
      if (payload.subtitleTrack) {
        await syncTranscriptTrack(context, payload.subtitleTrack);
      }
    } else {
      context.transcriptStore.stopSession(payload.sessionId);
      broadcastState(context.config, context.transcriptStore, context.sockets);
    }
    respondJson(response, 200, {
      success: true,
      message: 'Session updated.',
      state: context.transcriptStore.getState(),
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/subtitle-event') {
    const payload = await readJsonBody<SubtitleEventPayload>(request);
    context.transcriptStore.pushSubtitle(payload);
    broadcastState(context.config, context.transcriptStore, context.sockets);
    respondJson(response, 200, {
      success: true,
      message: 'Subtitle event recorded.',
      state: context.transcriptStore.getState(),
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/subtitle-track') {
    const payload = parseSubtitleTrackPayload(await readJsonBody<unknown>(request), 'subtitle track payload');
    assertActiveSession(context.transcriptStore, payload.sessionId);
    context.transcriptStore.setSubtitleTrack(payload);
    broadcastState(context.config, context.transcriptStore, context.sockets);
    await syncTranscriptTrack(context, payload);
    respondJson(response, 200, {
      success: true,
      message: 'Subtitle track updated.',
      state: context.transcriptStore.getState(),
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/mine') {
    const payload = await readJsonBody<MinePayload>(request);
    const result = await mapMineErrorToHttp(() => mineToAnki(context.config.anki, payload));
    broadcastToast(context.sockets, {
      kind: 'success',
      message: result.message,
    });
    respondJson(response, 200, result);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/runtime/shutdown') {
    respondJson(response, 200, {
      success: true,
      message: 'Shutdown requested.',
    });
    setImmediate(() => context.requestShutdown?.('runtime shutdown request'));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/history/go-to') {
    const payload = await readJsonBody<SubtitleEventPayload>(request);
    assertActiveSession(context.transcriptStore, payload.sessionId);
    const command = context.playerCommandStore.queueSeek(payload);
    respondJson(response, 200, {
      success: true,
      message: `Queued seek to ${command.startMs} ms.`,
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/player-command') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      throw new HttpError(400, 'Expected sessionId query parameter.');
    }

    respondJson(response, 200, context.playerCommandStore.claim(sessionId));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/history/mine') {
    const payload = parseHistoryMineRequestPayload(await readJsonBody<unknown>(request));
    assertActiveHistoryMineRequest(context.transcriptStore, payload);
    const result = await mapMineErrorToHttp(() => mineHistoryEntry(context.config, payload));
    broadcastToast(context.sockets, {
      kind: 'success',
      message: result.message,
    });
    respondJson(response, 200, result);
    return;
  }

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    await serveStatic(response, 'index.html', 'text/html; charset=utf-8');
    return;
  }

  if (method === 'GET' && url.pathname === '/app.js') {
    await serveStatic(response, 'app.js', 'text/javascript; charset=utf-8');
    return;
  }

  if (method === 'GET' && url.pathname === '/history-selection.js') {
    await serveStatic(response, 'history-selection.js', 'text/javascript; charset=utf-8');
    return;
  }

  if (method === 'GET' && url.pathname === '/transcript-render.js') {
    await serveStatic(response, 'transcript-render.js', 'text/javascript; charset=utf-8');
    return;
  }

  if (method === 'GET' && url.pathname === '/styles.css') {
    await serveStatic(response, 'styles.css', 'text/css; charset=utf-8');
    return;
  }

  if (method === 'GET' && url.pathname === '/favicon.svg') {
    await serveStatic(response, 'favicon.svg', 'image/svg+xml; charset=utf-8');
    return;
  }

  respondJson(response, 404, {
    success: false,
    message: `Route not found: ${method} ${url.pathname}`,
  });
}

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) {
    throw new HttpError(400, 'Expected a JSON request body.');
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON request body.');
  }
}

async function serveStatic(response: http.ServerResponse, filename: string, contentType: string): Promise<void> {
  const content = await fs.readFile(path.join(WEB_ROOT, filename), 'utf8');
  response.writeHead(200, { 'content-type': contentType });
  response.end(content);
}

function respondJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function getSettingsOptions(
  config: AppConfig,
  requestedDeck: string,
  requestedNoteType: string,
): Promise<SettingsOptions> {
  const [decks, noteTypes] = await Promise.all([listDeckNames(config.anki), listModelNames(config.anki)]);
  const selectedDeck = decks.includes(requestedDeck) ? requestedDeck : (decks[0] ?? '');
  const selectedNoteType = noteTypes.includes(requestedNoteType) ? requestedNoteType : (noteTypes[0] ?? '');
  const noteFields = selectedNoteType ? await listModelFieldNames(config.anki, selectedNoteType) : [];

  return {
    decks,
    noteTypes,
    noteFields,
    selectedDeck,
    selectedNoteType,
  };
}

function assertActiveSession(transcriptStore: TranscriptStore, sessionId: string): void {
  const activeSessionId = transcriptStore.getState().session?.sessionId;
  if (!activeSessionId) {
    throw new HttpError(409, 'No active transcript session is available.');
  }

  if (activeSessionId !== sessionId) {
    throw new HttpError(409, 'The requested history entry does not belong to the active session.');
  }
}

function assertActiveHistoryMineRequest(transcriptStore: TranscriptStore, payload: HistoryMineRequest): void {
  if ('entries' in payload) {
    if (payload.entries.length === 0) {
      throw new HttpError(400, 'Select at least one subtitle line to mine.');
    }

    const transcript = transcriptStore.getState().transcript;
    const transcriptIndexesByKey = new Map(transcript.map((entry, index) => [payloadKey(entry), index]));
    const selectedIndexes: number[] = [];

    for (const entry of payload.entries) {
      assertActiveSession(transcriptStore, entry.sessionId);

      const index = transcriptIndexesByKey.get(payloadKey(entry));
      if (index == null) {
        throw new HttpError(409, 'The requested subtitle selection is no longer available in the active transcript.');
      }

      selectedIndexes.push(index);
    }

    const uniqueSortedIndexes = [...new Set(selectedIndexes)].sort((a, b) => a - b);
    const isConsecutive = uniqueSortedIndexes.every((index, position) => {
      if (position === 0) {
        return true;
      }

      return index === uniqueSortedIndexes[position - 1] + 1;
    });
    if (!isConsecutive || uniqueSortedIndexes.length !== payload.entries.length) {
      throw new HttpError(400, 'Selected subtitle lines must be consecutive.');
    }
    return;
  }

  assertActiveSession(transcriptStore, payload.sessionId);
}

async function syncTranscriptTrack(context: ServerContext, track: SubtitleTrackPayload): Promise<void> {
  const result = await loadSubtitleTranscript(context.config, track);
  if (result.status === 'ready') {
    context.transcriptStore.setTranscript(track, result.transcript);
  } else if (result.status === 'unavailable') {
    context.transcriptStore.setTranscriptUnavailable(track, result.message ?? 'The active subtitle track is unavailable.');
  } else {
    context.transcriptStore.setTranscriptError(track, result.message ?? 'The active subtitle track could not be loaded.');
  }

  broadcastState(context.config, context.transcriptStore, context.sockets);
}

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export function buildStatePayload(config: AppConfig, transcriptStore: TranscriptStore): StatePayload {
  return {
    success: true,
    config: {
      capture: config.capture,
      server: config.server,
      appearance: config.appearance,
      settings: getEditableSettings(config),
    },
    state: transcriptStore.getState(),
  };
}

function broadcastState(config: AppConfig, transcriptStore: TranscriptStore, sockets: WebSocketHub): void {
  sockets.broadcastJson({
    type: 'state',
    payload: buildStatePayload(config, transcriptStore),
  });
}

function broadcastToast(
  sockets: WebSocketHub,
  payload: {
    kind: 'success' | 'error';
    message: string;
  },
): void {
  sockets.broadcastJson({
    type: 'toast',
    payload,
  });
}

function parseEditableSettingsPayload(payload: unknown): EditableSettings {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'Expected a settings object.');
  }

  const root = payload as Record<string, unknown>;
  const anki = getRecord(root.anki, 'anki');
  const fields = getRecord(anki.fields, 'anki.fields');
  const capture = getRecord(root.capture, 'capture');
  const runtime = getRecord(root.runtime, 'runtime');
  const appearance = getRecord(root.appearance, 'appearance');

  return {
    anki: {
      deck: getString(anki.deck, 'anki.deck', { allowEmpty: false }),
      noteType: getString(anki.noteType, 'anki.noteType', { allowEmpty: false }),
      extraQuery: getString(anki.extraQuery, 'anki.extraQuery'),
      fields: {
        subtitle: getString(fields.subtitle, 'anki.fields.subtitle', { allowEmpty: false }),
        audio: getString(fields.audio, 'anki.fields.audio'),
        image: getString(fields.image, 'anki.fields.image'),
        source: getString(fields.source, 'anki.fields.source'),
        time: getString(fields.time, 'anki.fields.time'),
        filename: getString(fields.filename, 'anki.fields.filename'),
      },
      filenameTemplate: getString(anki.filenameTemplate, 'anki.filenameTemplate', { allowEmpty: false }),
    },
    capture: {
      audioPrePaddingMs: getInteger(capture.audioPrePaddingMs, 'capture.audioPrePaddingMs'),
      audioPostPaddingMs: getInteger(capture.audioPostPaddingMs, 'capture.audioPostPaddingMs'),
      audioFormat: getString(capture.audioFormat, 'capture.audioFormat', { allowEmpty: false }),
      audioCodec: getString(capture.audioCodec, 'capture.audioCodec', { allowEmpty: false }),
      audioBitrate: getString(capture.audioBitrate, 'capture.audioBitrate', { allowEmpty: false }),
      imageFormat: getString(capture.imageFormat, 'capture.imageFormat', { allowEmpty: false }),
      imageQuality: getInteger(capture.imageQuality, 'capture.imageQuality'),
      imageMaxWidth: getInteger(capture.imageMaxWidth, 'capture.imageMaxWidth'),
      imageMaxHeight: getInteger(capture.imageMaxHeight, 'capture.imageMaxHeight'),
      imageIncludeSubtitles: getBoolean(capture.imageIncludeSubtitles, 'capture.imageIncludeSubtitles'),
    },
    runtime: {
      captureAudio: getBoolean(runtime.captureAudio, 'runtime.captureAudio'),
      captureImage: getBoolean(runtime.captureImage, 'runtime.captureImage'),
    },
    appearance: {
      subtitleCardFontFamily: getString(appearance.subtitleCardFontFamily, 'appearance.subtitleCardFontFamily'),
    },
  };
}

async function validateEditableSettings(config: AppConfig, settings: EditableSettings): Promise<void> {
  if (settings.capture.audioPrePaddingMs < 0) {
    throw new HttpError(400, 'capture.audioPrePaddingMs must be 0 or greater.');
  }

  if (settings.capture.audioPostPaddingMs < 0) {
    throw new HttpError(400, 'capture.audioPostPaddingMs must be 0 or greater.');
  }

  if (settings.capture.imageQuality < 0) {
    throw new HttpError(400, 'capture.imageQuality must be 0 or greater.');
  }

  if (settings.capture.imageMaxWidth <= 0 || settings.capture.imageMaxHeight <= 0) {
    throw new HttpError(400, 'capture image dimensions must be greater than 0.');
  }

  const noteFields = await listModelFieldNames(config.anki, settings.anki.noteType);
  const noteFieldSet = new Set(noteFields);
  const fieldEntries = [
    ['subtitle', settings.anki.fields.subtitle],
    ['audio', settings.anki.fields.audio],
    ['image', settings.anki.fields.image],
    ['source', settings.anki.fields.source ?? ''],
    ['time', settings.anki.fields.time ?? ''],
    ['filename', settings.anki.fields.filename ?? ''],
  ] as const;

  for (const [fieldKey, fieldName] of fieldEntries) {
    if (!fieldName) {
      continue;
    }

    if (!noteFieldSet.has(fieldName)) {
      throw new HttpError(
        400,
        `Configured ${fieldKey} field "${fieldName}" does not exist on Anki note type "${settings.anki.noteType}".`,
      );
    }
  }
}

function replaceConfig(target: AppConfig, next: AppConfig): void {
  target.server = next.server;
  target.anki = next.anki;
  target.capture = next.capture;
  target.runtime = next.runtime;
  target.appearance = next.appearance;
}

async function refreshConfigFromDisk(context: ServerContext): Promise<void> {
  replaceConfig(
    context.config,
    await loadConfigFromPath(context.configPath, {
      appRoot: APP_ROOT,
    }),
  );
}

function getRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${fieldName} must be an object.`);
  }

  return value as Record<string, unknown>;
}

async function mapMineErrorToHttp<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InvalidAnkiMiningConfigError) {
      throw new HttpError(400, error.message);
    }

    if (error instanceof NoMatchingCardError) {
      throw new HttpError(404, error.message);
    }

    throw error;
  }
}

function parseHistoryMineRequestPayload(payload: unknown): HistoryMineRequest {
  if (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    'entries' in payload
  ) {
    const root = payload as Record<string, unknown>;
    if (!Array.isArray(root.entries)) {
      throw new HttpError(400, 'entries must be an array.');
    }

    return {
      entries: root.entries.map((entry, index) => parseSubtitleEventPayload(entry, `entries[${index}]`)),
    } satisfies HistoryMineBatchPayload;
  }

  return parseSubtitleEventPayload(payload, 'history mine payload');
}

function parseSessionPayload(payload: unknown): SessionPayload {
  const root = getRecord(payload, 'session payload');
  const action = getString(root.action, 'session payload.action', { allowEmpty: false });
  if (action !== 'start' && action !== 'stop') {
    throw new HttpError(400, 'session payload.action must be "start" or "stop".');
  }

  return {
    action,
    sessionId: getString(root.sessionId, 'session payload.sessionId', { allowEmpty: false }),
    filePath: getOptionalString(root.filePath, 'session payload.filePath'),
    durationMs: getNullableInteger(root.durationMs, 'session payload.durationMs'),
    playbackTimeMs: getNullableInteger(root.playbackTimeMs, 'session payload.playbackTimeMs'),
    subtitleTrack: root.subtitleTrack == null ? null : parseSubtitleTrackPayload(root.subtitleTrack, 'session payload.subtitleTrack'),
  };
}

function parseSubtitleTrackPayload(value: unknown, fieldName: string): SubtitleTrackPayload {
  const root = getRecord(value, fieldName);
  const kind = getString(root.kind, `${fieldName}.kind`, { allowEmpty: false });
  if (kind !== 'external' && kind !== 'embedded' && kind !== 'none') {
    throw new HttpError(400, `${fieldName}.kind must be "external", "embedded", or "none".`);
  }

  return {
    sessionId: getString(root.sessionId, `${fieldName}.sessionId`, { allowEmpty: false }),
    filePath: getString(root.filePath, `${fieldName}.filePath`, { allowEmpty: false }),
    kind,
    externalFilePath: getOptionalString(root.externalFilePath, `${fieldName}.externalFilePath`),
    trackId: getNullableInteger(root.trackId, `${fieldName}.trackId`),
    ffIndex: getNullableInteger(root.ffIndex, `${fieldName}.ffIndex`),
    codec: getOptionalString(root.codec, `${fieldName}.codec`),
    title: getOptionalString(root.title, `${fieldName}.title`),
    lang: getOptionalString(root.lang, `${fieldName}.lang`),
  };
}

function parseSubtitleEventPayload(value: unknown, fieldName: string): SubtitleEventPayload {
  const root = getRecord(value, fieldName);

  return {
    sessionId: getString(root.sessionId, `${fieldName}.sessionId`, { allowEmpty: false }),
    text: getString(root.text, `${fieldName}.text`),
    startMs: getNullableInteger(root.startMs, `${fieldName}.startMs`),
    endMs: getNullableInteger(root.endMs, `${fieldName}.endMs`),
    playbackTimeMs: getNullableInteger(root.playbackTimeMs, `${fieldName}.playbackTimeMs`),
    filePath: getString(root.filePath, `${fieldName}.filePath`, { allowEmpty: false }),
  };
}

function getString(value: unknown, fieldName: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${fieldName} must be a string.`);
  }

  const normalized = value.trim();
  if (options.allowEmpty === false && !normalized) {
    throw new HttpError(400, `${fieldName} cannot be empty.`);
  }

  return normalized;
}

function getOptionalString(value: unknown, fieldName: string): string | null {
  if (value == null) {
    return null;
  }

  return getString(value, fieldName);
}

function getInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value)) {
    throw new HttpError(400, `${fieldName} must be an integer.`);
  }

  return value;
}

function getNullableInteger(value: unknown, fieldName: string): number | null {
  if (value == null) {
    return null;
  }

  return getInteger(value, fieldName);
}

function getBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpError(400, `${fieldName} must be a boolean.`);
  }

  return value;
}
