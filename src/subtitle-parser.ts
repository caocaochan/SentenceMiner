import type { TranscriptCue } from './types.ts';

const BOM_RE = /^\uFEFF/;
const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export interface ParseSubtitleTranscriptOptions {
  sessionId: string;
  filePath: string;
  sourcePath?: string | null;
}

interface ParsedCue {
  text: string;
  startMs: number;
  endMs: number;
}

export function parseSubtitleTranscript(raw: string, options: ParseSubtitleTranscriptOptions): TranscriptCue[] {
  const normalized = normalizeInput(raw);
  if (!normalized.trim()) {
    return [];
  }

  const sourceHint = options.sourcePath?.toLowerCase() ?? '';
  const parsers = buildParserOrder(sourceHint, normalized);

  for (const parser of parsers) {
    const parsed = parser(normalized);
    if (parsed.length > 0) {
      return parsed.map((cue, index) => buildTranscriptCue(cue, index, options));
    }
  }

  return [];
}

function buildParserOrder(sourceHint: string, raw: string): Array<(input: string) => ParsedCue[]> {
  const ordered: Array<(input: string) => ParsedCue[]> = [];

  if (sourceHint.endsWith('.ass') || sourceHint.endsWith('.ssa')) {
    ordered.push(parseAssTranscript);
  } else if (sourceHint.endsWith('.vtt')) {
    ordered.push(parseVttTranscript);
  } else if (sourceHint.endsWith('.srt')) {
    ordered.push(parseSrtTranscript);
  }

  if (raw.startsWith('WEBVTT')) {
    ordered.unshift(parseVttTranscript);
  }
  if (/^\[Script Info\]/m.test(raw) || /^\[Events\]/m.test(raw) || /^\s*Dialogue:/m.test(raw)) {
    ordered.unshift(parseAssTranscript);
  }
  if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(raw)) {
    ordered.unshift(parseSrtTranscript);
  }
  if (/\d{2}:\d{2}[.:]\d{3}\s+-->\s+\d{2}:\d{2}[.:]\d{3}/.test(raw)) {
    ordered.unshift(parseVttTranscript);
  }

  ordered.push(parseSrtTranscript, parseVttTranscript, parseAssTranscript);
  return [...new Set(ordered)];
}

function buildTranscriptCue(
  cue: ParsedCue,
  orderIndex: number,
  options: ParseSubtitleTranscriptOptions,
): TranscriptCue {
  return {
    id: [options.sessionId, orderIndex, cue.startMs, cue.endMs].join(':'),
    orderIndex,
    sessionId: options.sessionId,
    filePath: options.filePath,
    text: cue.text,
    startMs: cue.startMs,
    endMs: cue.endMs,
    playbackTimeMs: cue.startMs,
  };
}

function parseSrtTranscript(raw: string): ParsedCue[] {
  const blocks = raw.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const cues: ParsedCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 2) {
      continue;
    }

    const timingLineIndex = lines[0].includes('-->') ? 0 : 1;
    const timingLine = lines[timingLineIndex];
    const timing = parseTimingLine(timingLine, ',');
    if (!timing) {
      continue;
    }

    const text = normalizeCueText(lines.slice(timingLineIndex + 1).join('\n'));
    if (!text) {
      continue;
    }

    cues.push({
      text,
      startMs: timing.startMs,
      endMs: timing.endMs,
    });
  }

  return cues;
}

function parseVttTranscript(raw: string): ParsedCue[] {
  const blocks = raw.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const cues: ParsedCue[] = [];

  for (const block of blocks) {
    if (/^(WEBVTT|NOTE\b|STYLE\b|REGION\b)/.test(block)) {
      continue;
    }

    const lines = block.split('\n');
    if (lines.length < 2) {
      continue;
    }

    const timingLineIndex = lines[0].includes('-->') ? 0 : 1;
    const timing = parseTimingLine(lines[timingLineIndex], '.');
    if (!timing) {
      continue;
    }

    const text = normalizeCueText(lines.slice(timingLineIndex + 1).join('\n'));
    if (!text) {
      continue;
    }

    cues.push({
      text,
      startMs: timing.startMs,
      endMs: timing.endMs,
    });
  }

  return cues;
}

function parseAssTranscript(raw: string): ParsedCue[] {
  const lines = raw.split('\n');
  let inEvents = false;
  let formatFields: string[] | null = null;
  const cues: ParsedCue[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (/^\[events\]/i.test(trimmed)) {
      inEvents = true;
      formatFields = null;
      continue;
    }

    if (!inEvents) {
      continue;
    }

    if (/^\[.+\]$/.test(trimmed)) {
      break;
    }

    if (/^format:/i.test(trimmed)) {
      formatFields = trimmed
        .slice(trimmed.indexOf(':') + 1)
        .split(',')
        .map((field) => field.trim().toLowerCase());
      continue;
    }

    if (!/^dialogue:/i.test(trimmed)) {
      continue;
    }

    const values = splitAssDialogue(trimmed.slice(trimmed.indexOf(':') + 1), formatFields?.length ?? 10);
    const fields = formatFields ?? ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const startIndex = fields.indexOf('start');
    const endIndex = fields.indexOf('end');
    const textIndex = fields.indexOf('text');
    if (startIndex === -1 || endIndex === -1 || textIndex === -1) {
      continue;
    }

    const startMs = parseAssTimestamp(values[startIndex] ?? '');
    const endMs = parseAssTimestamp(values[endIndex] ?? '');
    if (startMs == null || endMs == null) {
      continue;
    }

    const text = normalizeAssText(values[textIndex] ?? '');
    if (!text) {
      continue;
    }

    cues.push({
      text,
      startMs,
      endMs,
    });
  }

  return cues;
}

function splitAssDialogue(raw: string, expectedFieldCount: number): string[] {
  const values: string[] = [];
  let remaining = raw;

  for (let index = 0; index < expectedFieldCount - 1; index += 1) {
    const commaIndex = remaining.indexOf(',');
    if (commaIndex === -1) {
      values.push(remaining.trim());
      remaining = '';
      continue;
    }

    values.push(remaining.slice(0, commaIndex).trim());
    remaining = remaining.slice(commaIndex + 1);
  }

  values.push(remaining.trim());
  return values;
}

function parseTimingLine(line: string, decimalSeparator: ',' | '.'): { startMs: number; endMs: number } | null {
  const [startPart, endPart] = line.split(/\s+-->\s+/);
  if (!startPart || !endPart) {
    return null;
  }

  const startMs = parseTimestamp(startPart, decimalSeparator);
  const endMs = parseTimestamp(endPart.split(/\s+/)[0] ?? '', decimalSeparator);
  if (startMs == null || endMs == null) {
    return null;
  }

  return { startMs, endMs };
}

function parseTimestamp(raw: string, decimalSeparator: ',' | '.'): number | null {
  const trimmed = raw.trim();
  const match =
    decimalSeparator === ','
      ? trimmed.match(/^(?:(\d+):)?(\d{2}):(\d{2}),(\d{3})$/)
      : trimmed.match(/^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/);
  if (!match) {
    return null;
  }

  const hours = Number.parseInt(match[1] ?? '0', 10);
  const minutes = Number.parseInt(match[2] ?? '0', 10);
  const seconds = Number.parseInt(match[3] ?? '0', 10);
  const milliseconds = Number.parseInt(match[4] ?? '0', 10);

  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function parseAssTimestamp(raw: string): number | null {
  const match = raw.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!match) {
    return null;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const centiseconds = Number.parseInt(match[4], 10);

  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + (centiseconds * 10);
}

function normalizeCueText(raw: string): string {
  return decodeEntities(
    raw
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n'),
  ).trim();
}

function normalizeAssText(raw: string): string {
  return decodeEntities(
    raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n'),
  ).trim();
}

function normalizeInput(raw: string): string {
  return raw.replace(BOM_RE, '').replace(/\r\n?/g, '\n');
}

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, token: string) => {
    const normalized = token.toLowerCase();
    if (normalized.startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    }
    if (normalized.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    }

    return ENTITY_MAP[normalized] ?? match;
  });
}
