export type SessionAction = 'start' | 'stop';

export interface SessionPayload {
  action: SessionAction;
  sessionId: string;
  filePath?: string;
  durationMs?: number | null;
  playbackTimeMs?: number | null;
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
}

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
  ffmpegPath: string;
  tempDir: string;
  captureAudio: boolean;
  captureImage: boolean;
}

export interface TranscriptConfig {
  historyLimit: number;
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
  transcript: TranscriptConfig;
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
}

export interface SettingsOptions {
  decks: string[];
  noteTypes: string[];
  noteFields: string[];
}

export interface StatePayload {
  success: boolean;
  config: {
    capture: CaptureConfig;
    transcript: TranscriptConfig;
    server: ServerConfig;
    settings: EditableSettings;
  };
  state: TranscriptState;
}

export interface SettingsOptionsPayload {
  success: boolean;
  options: SettingsOptions;
}

export interface TranscriptState {
  session: {
    sessionId: string;
    filePath: string;
    durationMs: number | null;
    playbackTimeMs: number | null;
  } | null;
  currentSubtitle: SubtitleEventPayload | null;
  history: SubtitleEventPayload[];
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
