import type { SessionPayload, SubtitleEventPayload, TranscriptState } from './types.ts';
import { payloadKey } from './utils.ts';

export class TranscriptStore {
  #state: TranscriptState = {
    session: null,
    currentSubtitle: null,
    history: [],
  };

  readonly #historyLimit: number;

  constructor(historyLimit: number) {
    this.#historyLimit = Math.max(1, historyLimit);
  }

  startSession(payload: SessionPayload): TranscriptState {
    this.#state = {
      session: {
        sessionId: payload.sessionId,
        filePath: payload.filePath ?? this.#state.session?.filePath ?? '',
        durationMs: payload.durationMs ?? null,
        playbackTimeMs: payload.playbackTimeMs ?? null,
      },
      currentSubtitle: null,
      history: [],
    };

    return this.getState();
  }

  stopSession(sessionId: string): TranscriptState {
    if (this.#state.session?.sessionId !== sessionId) {
      return this.getState();
    }

    this.#state = {
      session: null,
      currentSubtitle: null,
      history: [],
    };

    return this.getState();
  }

  updatePlaybackTime(playbackTimeMs: number | null): TranscriptState {
    if (!this.#state.session) {
      return this.getState();
    }

    this.#state.session = {
      ...this.#state.session,
      playbackTimeMs,
    };
    return this.getState();
  }

  pushSubtitle(payload: SubtitleEventPayload): TranscriptState {
    if (!this.#state.session || this.#state.session.sessionId !== payload.sessionId) {
      this.startSession({
        action: 'start',
        sessionId: payload.sessionId,
        filePath: payload.filePath,
      });
    }

    this.#state.session = this.#state.session
      ? {
          ...this.#state.session,
          filePath: payload.filePath,
          playbackTimeMs: payload.playbackTimeMs,
        }
      : null;

    if (!payload.text.trim()) {
      this.#state.currentSubtitle = null;
      return this.getState();
    }

    const currentKey = this.#state.currentSubtitle ? payloadKey(this.#state.currentSubtitle) : null;
    const nextKey = payloadKey(payload);
    this.#state.currentSubtitle = payload;

    if (currentKey === nextKey) {
      return this.getState();
    }

    const existingIndex = this.#state.history.findIndex((entry) => payloadKey(entry) === nextKey);
    if (existingIndex === -1) {
      this.#state.history.push(payload);
      if (this.#state.history.length > this.#historyLimit) {
        this.#state.history = this.#state.history.slice(-this.#historyLimit);
      }
    } else {
      this.#state.history[existingIndex] = payload;
    }

    return this.getState();
  }

  getState(): TranscriptState {
    return {
      session: this.#state.session ? { ...this.#state.session } : null,
      currentSubtitle: this.#state.currentSubtitle ? { ...this.#state.currentSubtitle } : null,
      history: this.#state.history.map((entry) => ({ ...entry })),
    };
  }
}
