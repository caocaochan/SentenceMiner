import type { PlaybackMode, SubtitleEventPayload } from './types.ts';

export interface SeekPlayerCommand {
  type: 'seek';
  startMs: number;
}

export interface SetPlaybackModePlayerCommand {
  type: 'set-playback-mode';
  mode: PlaybackMode;
}

export type PlayerCommand = SeekPlayerCommand | SetPlaybackModePlayerCommand;

export class PlayerCommandStore {
  #commands = new Map<string, PlayerCommand>();

  queueSeek(payload: SubtitleEventPayload): SeekPlayerCommand {
    if (payload.startMs == null) {
      throw new Error('Cannot seek to a history entry without a start time.');
    }

    const command: SeekPlayerCommand = {
      type: 'seek',
      startMs: payload.startMs,
    };

    this.#commands.set(payload.sessionId, command);
    return { ...command };
  }

  setPlaybackMode(sessionId: string, mode: PlaybackMode): SetPlaybackModePlayerCommand {
    const command: SetPlaybackModePlayerCommand = {
      type: 'set-playback-mode',
      mode,
    };

    this.#commands.set(sessionId, command);
    return { ...command };
  }

  claim(sessionId: string): PlayerCommand | null {
    const command = this.#commands.get(sessionId);
    if (!command) {
      return null;
    }

    this.#commands.delete(sessionId);
    return { ...command };
  }

  clearSession(sessionId: string): void {
    this.#commands.delete(sessionId);
  }

  clearAll(): void {
    this.#commands.clear();
  }
}
