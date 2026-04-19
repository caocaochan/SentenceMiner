import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { mineToAnki } from './anki.ts';
import { loadConfig, resolveAppRoot } from './config.ts';
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
  const config = await loadConfig();
  const transcriptStore = new TranscriptStore(config.transcript.historyLimit);
  const sockets = new WebSocketHub();

  const server = http.createServer(async (request, response) => {
    try {
      await routeRequest(config, transcriptStore, sockets, request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respondJson(response, 500, {
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

  server.listen(config.server.port, config.server.host, () => {
    console.log(`SentenceMiner helper listening on http://${config.server.host}:${config.server.port}`);
  });
}

async function routeRequest(
  config: Awaited<ReturnType<typeof loadConfig>>,
  transcriptStore: TranscriptStore,
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
    throw new Error('Expected a JSON request body.');
  }

  return JSON.parse(body) as T;
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
