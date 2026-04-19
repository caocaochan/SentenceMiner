import type {
  SessionPayload,
  SubtitleEventPayload,
  SubtitleTrackPayload,
  TranscriptCue,
  TranscriptState,
  TranscriptStatus,
} from './types.ts';

export class TranscriptStore {
  #state: TranscriptState = {
    session: null,
    currentSubtitle: null,
    transcript: [],
    history: [],
    currentCueId: null,
    transcriptStatus: 'unavailable',
    transcriptMessage: 'No active subtitle track is selected.',
  };

  startSession(payload: SessionPayload): TranscriptState {
    this.#state = {
      session: {
        sessionId: payload.sessionId,
        filePath: payload.filePath ?? this.#state.session?.filePath ?? '',
        durationMs: payload.durationMs ?? null,
        playbackTimeMs: payload.playbackTimeMs ?? null,
        subtitleTrack: payload.subtitleTrack ?? null,
      },
      currentSubtitle: null,
      transcript: [],
      history: [],
      currentCueId: null,
      transcriptStatus: 'loading',
      transcriptMessage: 'Loading active subtitle track…',
    };

    if (!payload.subtitleTrack || payload.subtitleTrack.kind === 'none') {
      this.setTranscriptUnavailable(payload.subtitleTrack ?? buildMissingTrackPayload(payload), 'No active subtitle track is selected.');
    }

    return this.getState();
  }

  stopSession(sessionId: string): TranscriptState {
    if (this.#state.session?.sessionId !== sessionId) {
      return this.getState();
    }

    this.#state = {
      session: null,
      currentSubtitle: null,
      transcript: [],
      history: [],
      currentCueId: null,
      transcriptStatus: 'unavailable',
      transcriptMessage: 'No active subtitle track is selected.',
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
    this.#state.currentCueId = matchTranscriptCueId(this.#state.transcript, this.#state.currentSubtitle, playbackTimeMs);
    return this.getState();
  }

  setSubtitleTrack(track: SubtitleTrackPayload): TranscriptState {
    if (!this.#state.session || this.#state.session.sessionId !== track.sessionId) {
      return this.getState();
    }

    this.#state.session = {
      ...this.#state.session,
      filePath: track.filePath,
      subtitleTrack: { ...track },
    };
    this.#state.transcript = [];
    this.#state.history = [];
    this.#state.currentCueId = null;
    this.#state.transcriptStatus = 'loading';
    this.#state.transcriptMessage =
      track.kind === 'none' ? 'No active subtitle track is selected.' : 'Loading active subtitle track…';
    return this.getState();
  }

  setTranscript(track: SubtitleTrackPayload, transcript: TranscriptCue[]): TranscriptState {
    if (!this.#state.session || this.#state.session.sessionId !== track.sessionId) {
      return this.getState();
    }

    this.#state.session = {
      ...this.#state.session,
      filePath: track.filePath,
      subtitleTrack: { ...track },
    };
    this.#state.transcript = transcript.map((cue) => ({ ...cue }));
    this.#state.history = this.#state.transcript.map((cue) => ({ ...cue }));
    this.#state.transcriptStatus = 'ready';
    this.#state.transcriptMessage = null;
    this.#state.currentCueId = matchTranscriptCueId(
      this.#state.transcript,
      this.#state.currentSubtitle,
      this.#state.session.playbackTimeMs,
    );
    return this.getState();
  }

  setTranscriptUnavailable(track: SubtitleTrackPayload, message: string): TranscriptState {
    return this.#setTranscriptNotReady('unavailable', track, message);
  }

  setTranscriptError(track: SubtitleTrackPayload, message: string): TranscriptState {
    return this.#setTranscriptNotReady('error', track, message);
  }

  pushSubtitle(payload: SubtitleEventPayload): TranscriptState {
    if (!this.#state.session || this.#state.session.sessionId !== payload.sessionId) {
      this.startSession({
        action: 'start',
        sessionId: payload.sessionId,
        filePath: payload.filePath,
        playbackTimeMs: payload.playbackTimeMs,
      });
    }

    this.#state.session = this.#state.session
      ? {
          ...this.#state.session,
          filePath: payload.filePath,
          playbackTimeMs: payload.playbackTimeMs,
        }
      : null;

    this.#state.currentSubtitle = payload.text.trim()
      ? {
          ...payload,
        }
      : null;
    this.#state.currentCueId = matchTranscriptCueId(this.#state.transcript, payload, payload.playbackTimeMs);

    return this.getState();
  }

  getState(): TranscriptState {
    return {
      session: this.#state.session
        ? {
            ...this.#state.session,
            subtitleTrack: this.#state.session.subtitleTrack ? { ...this.#state.session.subtitleTrack } : null,
          }
        : null,
      currentSubtitle: this.#state.currentSubtitle ? { ...this.#state.currentSubtitle } : null,
      transcript: this.#state.transcript.map((cue) => ({ ...cue })),
      history: this.#state.history.map((cue) => ({ ...cue })),
      currentCueId: this.#state.currentCueId,
      transcriptStatus: this.#state.transcriptStatus,
      transcriptMessage: this.#state.transcriptMessage,
    };
  }

  #setTranscriptNotReady(status: Exclude<TranscriptStatus, 'ready' | 'loading'>, track: SubtitleTrackPayload, message: string) {
    if (!this.#state.session || this.#state.session.sessionId !== track.sessionId) {
      return this.getState();
    }

    this.#state.session = {
      ...this.#state.session,
      filePath: track.filePath,
      subtitleTrack: { ...track },
    };
    this.#state.transcript = [];
    this.#state.history = [];
    this.#state.currentCueId = null;
    this.#state.transcriptStatus = status;
    this.#state.transcriptMessage = message;
    return this.getState();
  }
}

function buildMissingTrackPayload(payload: SessionPayload): SubtitleTrackPayload {
  return {
    sessionId: payload.sessionId,
    filePath: payload.filePath ?? '',
    kind: 'none',
    externalFilePath: null,
    trackId: null,
    ffIndex: null,
    codec: null,
    title: null,
    lang: null,
  };
}

function matchTranscriptCueId(
  transcript: TranscriptCue[],
  subtitle: SubtitleEventPayload | null,
  playbackTimeMs: number | null,
): string | null {
  if (transcript.length === 0) {
    return null;
  }

  const subtitleStart = subtitle?.startMs;
  const subtitleEnd = subtitle?.endMs;
  const subtitleText = subtitle?.text.trim() ?? '';
  const pointInTime = subtitle?.playbackTimeMs ?? playbackTimeMs;

  const candidates = transcript.filter((cue) => {
    if (subtitleStart != null && subtitleEnd != null) {
      return cue.startMs <= subtitleEnd && cue.endMs >= subtitleStart;
    }

    if (pointInTime != null) {
      return cue.startMs <= pointInTime && cue.endMs >= pointInTime;
    }

    return false;
  });

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1 || !subtitleText) {
    return candidates[0].id;
  }

  const normalizedSubtitle = normalizeComparableText(subtitleText);
  const textMatch = candidates.find((cue) => normalizeComparableText(cue.text) === normalizedSubtitle);
  return textMatch?.id ?? candidates[0].id;
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
