export type SessionAction = 'start' | 'stop';
export type TranscriptStatus = 'loading' | 'ready' | 'unavailable' | 'error';
export type SubtitleTrackKind = 'external' | 'embedded' | 'none';
export type PlaybackMode = 'off' | 'repeat' | 'pause-after' | 'subs-only';
export const PLAYBACK_MODES: readonly PlaybackMode[] = ['off', 'repeat', 'pause-after', 'subs-only'];

export interface PlaybackModeStatePayload {
  sessionId: string;
  mode: PlaybackMode;
}

export interface SubtitleTrackPayload {
  sessionId: string;
  filePath: string;
  kind: SubtitleTrackKind;
  externalFilePath?: string | null;
  trackId?: number | null;
  ffIndex?: number | null;
  codec?: string | null;
  title?: string | null;
  lang?: string | null;
}

export interface SessionPayload {
  action: SessionAction;
  sessionId: string;
  filePath?: string;
  durationMs?: number | null;
  playbackTimeMs?: number | null;
  subtitleTrack?: SubtitleTrackPayload | null;
}

export interface SubtitleEventPayload {
  sessionId: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
  playbackTimeMs: number | null;
  filePath: string;
}

export interface MinePayload extends SubtitleEventPayload {
  screenshotPath?: string | null;
  audioPath?: string | null;
  sentenceMatchCandidates?: string[];
}

export interface HistoryMineBatchPayload {
  entries: SubtitleEventPayload[];
}

export type HistoryMineRequest = SubtitleEventPayload | HistoryMineBatchPayload;

export interface FieldMapping {
  subtitle: string;
  audio: string;
  image: string;
  source?: string;
  time?: string;
  filename?: string;
}

export interface AnkiConfig {
  url: string;
  apiKey?: string;
  deck: string;
  noteType: string;
  extraQuery?: string;
  fields: FieldMapping;
  filenameTemplate: string;
}

export interface CaptureConfig {
  audioPrePaddingMs: number;
  audioPostPaddingMs: number;
  audioFormat: string;
  audioCodec: string;
  audioBitrate: string;
  imageFormat: string;
  imageQuality: number;
  imageMaxWidth: number;
  imageMaxHeight: number;
  imageIncludeSubtitles: boolean;
}

export interface RuntimeConfig {
  enabled: boolean;
  ffmpegPath: string;
  tempDir: string;
  captureAudio: boolean;
  captureImage: boolean;
}

export interface AppearanceConfig {
  subtitleCardFontFamily: string;
  subtitleCardFontSizePx: number;
}

export interface PlaybackShortcutConfig {
  bind: boolean;
  key: string;
}

export interface PlaybackConfig {
  repeatLine: PlaybackShortcutConfig;
  pauseAfterLine: PlaybackShortcutConfig;
  subsOnly: PlaybackShortcutConfig;
}

export interface ServerConfig {
  host: string;
  port: number;
}

export interface AppConfig {
  server: ServerConfig;
  anki: AnkiConfig;
  capture: CaptureConfig;
  runtime: RuntimeConfig;
  appearance: AppearanceConfig;
  playback: PlaybackConfig;
}

export interface EditableAnkiSettings {
  deck: string;
  noteType: string;
  extraQuery: string;
  fields: FieldMapping;
  filenameTemplate: string;
}

export interface EditableRuntimeSettings {
  captureAudio: boolean;
  captureImage: boolean;
}

export interface EditableSettings {
  anki: EditableAnkiSettings;
  capture: CaptureConfig;
  runtime: EditableRuntimeSettings;
  appearance: AppearanceConfig;
  playback: PlaybackConfig;
}

export interface SettingsOptions {
  decks: string[];
  noteTypes: string[];
  noteFields: string[];
  fonts: string[];
  selectedDeck: string;
  selectedNoteType: string;
}

export interface StatePayload {
  success: boolean;
  config: {
    capture: CaptureConfig;
    server: ServerConfig;
    appearance: AppearanceConfig;
    settings: EditableSettings;
  };
  state: TranscriptState;
}

export interface SettingsOptionsPayload {
  success: boolean;
  options: SettingsOptions;
}

export interface TranscriptCue extends SubtitleEventPayload {
  id: string;
  orderIndex: number;
}

export interface TranscriptState {
  session: {
    sessionId: string;
    filePath: string;
    durationMs: number | null;
    playbackTimeMs: number | null;
    subtitleTrack: SubtitleTrackPayload | null;
  } | null;
  currentSubtitle: SubtitleEventPayload | null;
  transcript: TranscriptCue[];
  history: TranscriptCue[];
  currentCueId: string | null;
  transcriptStatus: TranscriptStatus;
  transcriptMessage: string | null;
  playbackMode: PlaybackMode;
}

export interface MineResult {
  success: boolean;
  message: string;
  noteId?: number;
  media?: {
    audio?: string;
    image?: string;
  };
}
