import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { mineHistoryEntry } from './history-mine.ts';
import { mineToAnki } from './anki.ts';
import { buildAppUrl, openUrlInBrowser } from './browser.ts';
import { loadConfig, resolveAppRoot } from './config.ts';
import { parseParentPidArg, startParentWatch } from './parent-watch.ts';
import { PlayerCommandStore } from './player-command-store.ts';
import { TranscriptStore } from './transcript-store.ts';
import type { MinePayload, SessionPayload, SubtitleEventPayload } from './types.ts';
import { WebSocketHub } from './ws.ts';

const APP_ROOT = resolveAppRoot();
const WEB_ROOT = path.join(APP_ROOT, 'web');

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const parentPid = parseParentPidArg(process.argv.slice(2));
  const config = await loadConfig();
  const transcriptStore = new TranscriptStore(config.transcript.historyLimit);
  const playerCommandStore = new PlayerCommandStore();
  const sockets = new WebSocketHub();

  const server = http.createServer(async (request, response) => {
    try {
      await routeRequest(config, transcriptStore, playerCommandStore, sockets, request, response);
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
  });

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

  if (parentPid !== null) {
    stopParentWatch = startParentWatch(parentPid, () => {
      console.log(`SentenceMiner helper exiting because parent process ${parentPid} closed.`);
      shutdown('parent process exit');
    });
  }

  server.listen(config.server.port, config.server.host, () => {
    const appUrl = buildAppUrl(config.server);
    console.log(`SentenceMiner helper listening on ${appUrl}`);

    if (!openUrlInBrowser(appUrl)) {
      console.warn(`SentenceMiner helper could not auto-open a browser for ${appUrl}.`);
    }
  });
}

async function routeRequest(
  config: Awaited<ReturnType<typeof loadConfig>>,
  transcriptStore: TranscriptStore,
  playerCommandStore: PlayerCommandStore,
  sockets: WebSocketHub,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${config.server.host}:${config.server.port}`}`);

  if (method === 'GET' && url.pathname === '/api/state') {
    respondJson(response, 200, buildStatePayload(config, transcriptStore));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/session') {
    const payload = await readJsonBody<SessionPayload>(request);
    playerCommandStore.clearAll();
    if (payload.action === 'start') {
      transcriptStore.startSession(payload);
    } else {
      transcriptStore.stopSession(payload.sessionId);
    }
    broadcastState(config, transcriptStore, sockets);
    respondJson(response, 200, {
      success: true,
      message: 'Session updated.',
      state: transcriptStore.getState(),
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/subtitle-event') {
    const payload = await readJsonBody<SubtitleEventPayload>(request);
    transcriptStore.pushSubtitle(payload);
    broadcastState(config, transcriptStore, sockets);
    respondJson(response, 200, {
      success: true,
      message: 'Subtitle event recorded.',
      state: transcriptStore.getState(),
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/mine') {
    const payload = await readJsonBody<MinePayload>(request);
    const result = await mineToAnki(config.anki, payload);
    respondJson(response, 200, result);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/history/go-to') {
    const payload = await readJsonBody<SubtitleEventPayload>(request);
    assertActiveSession(transcriptStore, payload.sessionId);
    const command = playerCommandStore.queueSeek(payload);
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

    respondJson(response, 200, playerCommandStore.claim(sessionId));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/history/mine') {
    const payload = await readJsonBody<SubtitleEventPayload>(request);
    const result = await mineHistoryEntry(config, payload);
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

  if (method === 'GET' && url.pathname === '/styles.css') {
    await serveStatic(response, 'styles.css', 'text/css; charset=utf-8');
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

function assertActiveSession(transcriptStore: TranscriptStore, sessionId: string): void {
  const activeSessionId = transcriptStore.getState().session?.sessionId;
  if (!activeSessionId) {
    throw new HttpError(409, 'No active transcript session is available.');
  }

  if (activeSessionId !== sessionId) {
    throw new HttpError(409, 'The requested history entry does not belong to the active session.');
  }
}

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function buildStatePayload(config: Awaited<ReturnType<typeof loadConfig>>, transcriptStore: TranscriptStore) {
  return {
    success: true,
    config: {
      capture: config.capture,
      transcript: config.transcript,
      server: config.server,
    },
    state: transcriptStore.getState(),
  };
}

function broadcastState(
  config: Awaited<ReturnType<typeof loadConfig>>,
  transcriptStore: TranscriptStore,
  sockets: WebSocketHub,
): void {
  sockets.broadcastJson({
    type: 'state',
    payload: buildStatePayload(config, transcriptStore),
  });
}
