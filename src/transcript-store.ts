import type {
  SessionPayload,
  SubtitleEventPayload,
  SubtitleTrackPayload,
  TranscriptCue,
  TranscriptCueLearning,
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
    learningStatus: 'disabled',
    learningMessage: null,
  };
  #transcriptByStart: TranscriptCue[] = [];

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
      learningStatus: 'disabled',
      learningMessage: null,
    };
    this.#transcriptByStart = [];

    if (!payload.subtitleTrack || payload.subtitleTrack.kind === 'none') {
      this.setTranscriptUnavailable(payload.subtitleTrack ?? buildMissingTrackPayload(payload), 'No active subtitle track is selected.');
    }

    return this.getState();
  }

  stopSession(sessionId: string): TranscriptState {
    if (this.#state.session?.sessionId !== sessionId) {
      return this.getState();
    }

    if (this.#state.transcript.length > 0 || this.#state.history.length > 0) {
      this.#state = {
        ...this.#state,
        session: null,
        currentSubtitle: null,
        currentCueId: null,
        transcriptStatus: 'ready',
        transcriptMessage: 'Playback ended.',
      };
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
      learningStatus: 'disabled',
      learningMessage: null,
    };
    this.#transcriptByStart = [];

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
    this.#state.currentCueId = matchTranscriptCueId(this.#transcriptByStart, this.#state.currentSubtitle, playbackTimeMs);
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
    this.#transcriptByStart = [];
    this.#state.currentCueId = null;
    this.#state.transcriptStatus = 'loading';
    this.#state.transcriptMessage =
      track.kind === 'none' ? 'No active subtitle track is selected.' : 'Loading active subtitle track…';
    this.#state.learningStatus = 'disabled';
    this.#state.learningMessage = null;
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
    this.#state.transcript = transcript.map(cloneCueWithoutLearning);
    this.#state.history = this.#state.transcript.map(cloneCue);
    this.#transcriptByStart = [...this.#state.transcript].sort((left, right) =>
      left.startMs === right.startMs ? left.endMs - right.endMs : left.startMs - right.startMs,
    );
    this.#state.transcriptStatus = 'ready';
    this.#state.transcriptMessage = null;
    this.#state.learningStatus = 'disabled';
    this.#state.learningMessage = null;
    this.#state.currentCueId = matchTranscriptCueId(
      this.#transcriptByStart,
      this.#state.currentSubtitle,
      this.#state.session.playbackTimeMs,
    );
    if (!this.#state.currentSubtitle) {
      this.#state.currentSubtitle = buildSubtitleFromCueAtTime(
        this.#transcriptByStart,
        {
          sessionId: this.#state.session.sessionId,
          filePath: this.#state.session.filePath,
          playbackTimeMs: this.#state.session.playbackTimeMs,
        },
      );
    }
    return this.getState();
  }

  setLearningLoading(message = 'Analyzing transcript for i+1 lines…'): TranscriptState {
    if (this.#state.transcript.length === 0) {
      return this.getState();
    }

    this.#clearLearningAnnotations();
    this.#state.learningStatus = 'loading';
    this.#state.learningMessage = message;
    return this.getState();
  }

  setLearningDisabled(message: string | null = null): TranscriptState {
    this.#clearLearningAnnotations();
    this.#state.learningStatus = 'disabled';
    this.#state.learningMessage = message;
    return this.getState();
  }

  setLearningReady(annotations: Map<string, TranscriptCueLearning>, message: string | null = null): TranscriptState {
    const applyAnnotation = (cue: TranscriptCue): TranscriptCue => {
      const learning = annotations.get(cue.id);
      return {
        ...cue,
        learning: {
          unknownWords: learning ? [...learning.unknownWords] : [],
          iPlusOne: learning?.iPlusOne ?? false,
        },
      };
    };

    this.#state.transcript = this.#state.transcript.map(applyAnnotation);
    this.#state.history = this.#state.history.map(applyAnnotation);
    this.#transcriptByStart = this.#transcriptByStart.map(applyAnnotation);
    this.#state.learningStatus = 'ready';
    this.#state.learningMessage = message;
    return this.getState();
  }

  setLearningError(message: string): TranscriptState {
    this.#clearLearningAnnotations();
    this.#state.learningStatus = 'error';
    this.#state.learningMessage = message;
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
      : buildSubtitleFromCueAtTime(this.#transcriptByStart, payload);
    this.#state.currentCueId = matchTranscriptCueId(this.#transcriptByStart, payload, payload.playbackTimeMs);

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
      transcript: this.#state.transcript.map(cloneCue),
      history: this.#state.history.map(cloneCue),
      currentCueId: this.#state.currentCueId,
      transcriptStatus: this.#state.transcriptStatus,
      transcriptMessage: this.#state.transcriptMessage,
      learningStatus: this.#state.learningStatus,
      learningMessage: this.#state.learningMessage,
    };
  }

  getCurrentCueState(): Pick<TranscriptState, 'session' | 'currentSubtitle' | 'currentCueId'> {
    return {
      session: this.#state.session
        ? {
            ...this.#state.session,
            subtitleTrack: this.#state.session.subtitleTrack ? { ...this.#state.session.subtitleTrack } : null,
          }
        : null,
      currentSubtitle: this.#state.currentSubtitle ? { ...this.#state.currentSubtitle } : null,
      currentCueId: this.#state.currentCueId,
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
    this.#transcriptByStart = [];
    this.#state.currentCueId = null;
    this.#state.transcriptStatus = status;
    this.#state.transcriptMessage = message;
    this.#state.learningStatus = 'disabled';
    this.#state.learningMessage = null;
    return this.getState();
  }

  #clearLearningAnnotations(): void {
    this.#state.transcript = this.#state.transcript.map(cloneCueWithoutLearning);
    this.#state.history = this.#state.history.map(cloneCueWithoutLearning);
    this.#transcriptByStart = this.#transcriptByStart.map(cloneCueWithoutLearning);
  }
}

function cloneCue(cue: TranscriptCue): TranscriptCue {
  return {
    ...cue,
    learning: cue.learning
      ? {
          unknownWords: [...cue.learning.unknownWords],
          iPlusOne: cue.learning.iPlusOne,
        }
      : undefined,
  };
}

function cloneCueWithoutLearning(cue: TranscriptCue): TranscriptCue {
  const { learning: _learning, ...rest } = cue;
  return { ...rest };
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

  const candidates =
    subtitleStart != null && subtitleEnd != null
      ? findOverlappingCues(transcript, subtitleStart, subtitleEnd)
      : pointInTime != null
        ? findCuesAtTime(transcript, pointInTime)
        : [];

  if (candidates.length === 0) {
    if (pointInTime == null) {
      return null;
    }

    const mostRecentCue = findMostRecentCueByStartTime(transcript, pointInTime);
    return mostRecentCue?.id ?? null;
  }

  if (candidates.length === 1 || !subtitleText) {
    return candidates[0].id;
  }

  const normalizedSubtitle = normalizeComparableText(subtitleText);
  const textMatch = candidates.find((cue) => normalizeComparableText(cue.text) === normalizedSubtitle);
  return textMatch?.id ?? candidates[0].id;
}

function findMostRecentCueByStartTime(transcript: TranscriptCue[], pointInTime: number): TranscriptCue | null {
  const index = findLastCueIndexAtOrBefore(transcript, pointInTime);
  return index === -1 ? null : transcript[index];
}

function buildSubtitleFromCueAtTime(
  transcript: TranscriptCue[],
  payload: Pick<SubtitleEventPayload, 'sessionId' | 'filePath' | 'playbackTimeMs'>,
): SubtitleEventPayload | null {
  if (payload.playbackTimeMs == null) {
    return null;
  }

  const cue = findCueAtTime(transcript, payload.playbackTimeMs);
  if (!cue) {
    return null;
  }

  return {
    sessionId: payload.sessionId,
    filePath: payload.filePath || cue.filePath,
    text: cue.text,
    startMs: cue.startMs,
    endMs: cue.endMs,
    playbackTimeMs: payload.playbackTimeMs,
  };
}

function findCueAtTime(transcript: TranscriptCue[], pointInTime: number): TranscriptCue | null {
  const candidates = findCuesAtTime(transcript, pointInTime);
  return candidates[0] ?? null;
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function findCuesAtTime(transcript: TranscriptCue[], pointInTime: number): TranscriptCue[] {
  const index = findLastCueIndexAtOrBefore(transcript, pointInTime);
  if (index === -1) {
    return [];
  }

  const candidates: TranscriptCue[] = [];
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const cue = transcript[cursor];
    if (cue.endMs >= pointInTime) {
      candidates.unshift(cue);
    }
  }

  return candidates;
}

function findOverlappingCues(transcript: TranscriptCue[], startMs: number, endMs: number): TranscriptCue[] {
  const index = findLastCueIndexAtOrBefore(transcript, endMs);
  if (index === -1) {
    return [];
  }

  const candidates: TranscriptCue[] = [];
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const cue = transcript[cursor];
    if (cue.endMs >= startMs) {
      candidates.unshift(cue);
    }
  }

  return candidates;
}

function findLastCueIndexAtOrBefore(transcript: TranscriptCue[], pointInTime: number): number {
  let low = 0;
  let high = transcript.length - 1;
  let match = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (transcript[mid].startMs <= pointInTime) {
      match = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return match;
}
