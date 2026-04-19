import path from 'node:path';

import type { SubtitleEventPayload } from './types.ts';

const INVALID_FILENAME_RE = /[<>:"/\\|?*\u0000-\u001f]/g;
const WHITESPACE_RE = /\s+/g;
const HTML_BREAK_RE = /<\s*br\s*\/?\s*>/gi;
const HTML_BLOCK_RE = /<\/?(?:div|p|li|tr|td|th|ul|ol|table|blockquote)[^>]*>/gi;
const HTML_TAG_RE = /<[^>]+>/g;
const NUMERIC_ENTITY_RE = /&#(\d+);/g;
const HEX_ENTITY_RE = /&#x([0-9a-f]+);/gi;
const NAMED_ENTITY_RE = /&([a-z]+);/gi;

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sanitizeFilename(input: string): string {
  const sanitized = input
    .replace(INVALID_FILENAME_RE, '-')
    .replace(WHITESPACE_RE, ' ')
    .trim()
    .replaceAll(' ', '-');

  return sanitized || 'untitled';
}

export function basenameWithoutExtension(filePath: string): string {
  const parsed = path.parse(filePath);
  return parsed.name || 'untitled';
}

export function formatTimestampRange(startMs: number | null, endMs: number | null): string {
  if (startMs == null && endMs == null) {
    return '';
  }

  const start = startMs == null ? '--:--.--' : formatTimestamp(startMs);
  const end = endMs == null ? '--:--.--' : formatTimestamp(endMs);
  return `${start} - ${end}`;
}

export function formatTimestamp(ms: number): string {
  const totalMilliseconds = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

export function buildSearchQuery(deck: string, noteType: string, extraQuery?: string): string {
  const parts = [`deck:${quoteAnkiTerm(deck)}`, `note:${quoteAnkiTerm(noteType)}`];
  if (extraQuery && extraQuery.trim()) {
    parts.push(extraQuery.trim());
  }
  return parts.join(' ');
}

export function quoteAnkiTerm(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}"`;
}

export function renderSubtitleHtml(text: string): string {
  return escapeHtml(text).replaceAll('\n', '<br>');
}

export function normalizeSubtitleForMatching(text: string): string {
  const plainText = htmlToPlainText(text);
  return plainText.replace(WHITESPACE_RE, ' ').trim();
}

export function applyFilenameTemplate(
  template: string,
  payload: SubtitleEventPayload,
  kind: 'audio' | 'image',
  extension: string,
): string {
  const basename = sanitizeFilename(basenameWithoutExtension(payload.filePath));
  const replacements: Record<string, string> = {
    basename,
    file: basename,
    kind,
    ext: extension.replace(/^\./, ''),
    startMs: String(payload.startMs ?? 0),
    endMs: String(payload.endMs ?? 0),
    sessionId: sanitizeFilename(payload.sessionId),
    ts: String(Date.now()),
  };

  const rendered = template.replaceAll(/\{(\w+)\}/g, (_, token: string) => replacements[token] ?? token);
  return sanitizeFilenamePreservingExtension(rendered);
}

function sanitizeFilenamePreservingExtension(value: string): string {
  const ext = path.extname(value);
  const name = ext ? value.slice(0, -ext.length) : value;
  const sanitizedName = sanitizeFilename(name);
  const sanitizedExt = ext.replace(INVALID_FILENAME_RE, '');
  return `${sanitizedName}${sanitizedExt}`;
}

export function payloadKey(payload: SubtitleEventPayload): string {
  return [
    payload.sessionId,
    payload.filePath,
    payload.startMs ?? 'nil',
    payload.endMs ?? 'nil',
    payload.text,
  ].join('::');
}

function htmlToPlainText(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(HTML_BREAK_RE, '\n')
      .replace(HTML_BLOCK_RE, '\n')
      .replace(HTML_TAG_RE, ''),
  ).replace(/\r\n?/g, '\n');
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(HEX_ENTITY_RE, (_, value: string) => String.fromCodePoint(parseInt(value, 16)))
    .replace(NUMERIC_ENTITY_RE, (_, value: string) => String.fromCodePoint(parseInt(value, 10)))
    .replace(NAMED_ENTITY_RE, (match, name: string) => HTML_ENTITY_MAP[name.toLowerCase()] ?? match);
}
