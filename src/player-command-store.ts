import type { SubtitleEventPayload } from './types.ts';

export interface SeekPlayerCommand {
  type: 'seek';
  startMs: number;
}

export class PlayerCommandStore {
  #commands = new Map<string, SeekPlayerCommand>();

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

  claim(sessionId: string): SeekPlayerCommand | null {
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
