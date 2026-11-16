import type { MessageSignals } from '../db/store.js';

/** Bytes decoded from any single MIME part. */
export const MAX_PART_BYTES = 512 * 1024;
/** Characters of body text stored per message. */
export const MAX_STORED_BODY_CHARS = 64 * 1024;
const MAX_PARTS = 200;
const MAX_DEPTH = 12;

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface ParsedBody {
  text: string;
  source: 'plain' | 'html' | 'none';
  truncated: boolean;
}

export function header(headers: GmailHeader[] | undefined, name: string): string {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? '';
}

function charsetOf(part: GmailPart): string {
  const contentType = header(part.headers, 'content-type');
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? 'utf-8';
}

function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/** Gmail returns part data base64url-encoded with transfer encoding already removed. */
function decodePartData(part: GmailPart): { text: string; truncated: boolean } | null {
  const data = part.body?.data;
  if (!data) return null;
  // 4 base64 characters encode 3 bytes; cap before decoding.
  const maxChars = Math.ceil((MAX_PART_BYTES * 4) / 3);
  const truncated = data.length > maxChars;
  const bytes = Buffer.from(truncated ? data.slice(0, maxChars) : data, 'base64url');
  return { text: decodeBytes(bytes, charsetOf(part)), truncated };
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true;
  if (part.body?.attachmentId) return true;
  return /^\s*attachment/i.test(header(part.headers, 'content-disposition'));
}

/** Depth-first walk collecting the first text/plain and text/html leaves. */
function collect(root: GmailPart): { plain?: GmailPart; html?: GmailPart } {
  const found: { plain?: GmailPart; html?: GmailPart } = {};
  let visited = 0;
  const walk = (part: GmailPart, depth: number) => {
    if (depth > MAX_DEPTH || visited >= MAX_PARTS) return;
    visited += 1;
    const type = (part.mimeType ?? 'text/plain').toLowerCase();
    if (type.startsWith('multipart/')) {
      for (const child of part.parts ?? []) walk(child, depth + 1);
      return;
    }
    if (isAttachment(part)) return;
    if (type === 'text/plain' && !found.plain) found.plain = part;
    else if (type === 'text/html' && !found.html) found.html = part;
  };
  walk(root, 0);
  return found;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
  bull: '•',
  middot: '·',
  zwnj: '',
  zwj: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Convert HTML to plain text by stripping markup. Nothing is rendered,
 * executed, or fetched; the output is plain text shown as text.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head|title|template|noscript|svg|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|blockquote|section|article|header|footer)\s*>/gi, '\n')
      .replace(/<(td|th)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/<[^>]*$/g, ''),
  )
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strip control characters other than tab and newline. */
export function sanitizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function extractBody(payload: GmailPart): ParsedBody {
  const { plain, html } = collect(payload);
  let decoded: { text: string; truncated: boolean } | null = null;
  let source: ParsedBody['source'] = 'none';
  if (plain) {
    decoded = decodePartData(plain);
    if (decoded && decoded.text.trim()) source = 'plain';
    else decoded = null;
  }
  if (!decoded && html) {
    const raw = decodePartData(html);
    if (raw) {
      decoded = { text: htmlToText(raw.text), truncated: raw.truncated };
      source = 'html';
    }
  }
  if (!decoded) return { text: '', source: 'none', truncated: false };
  const text = sanitizeText(decoded.text).trim();
  const truncated = decoded.truncated || text.length > MAX_STORED_BODY_CHARS;
  return { text: text.slice(0, MAX_STORED_BODY_CHARS), source, truncated };
}

/** Decode RFC 2047 encoded-words that may remain in header values. */
export function decodeHeaderValue(value: string): string {
  const decoded = value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_match, charset: string, encoding: string, text: string) => {
    try {
      const bytes =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
              'latin1',
            );
      return decodeBytes(bytes, charset.toLowerCase());
    } catch {
      return text;
    }
  });
  return sanitizeText(decoded).replace(/\n/g, ' ').trim();
}

export function extractSignals(headers: GmailHeader[] | undefined): MessageSignals {
  const optional = (name: string, max: number) => {
    const value = decodeHeaderValue(header(headers, name));
    return value ? value.slice(0, max) : null;
  };
  return {
    hasListUnsubscribe: header(headers, 'list-unsubscribe') !== '',
    listId: optional('list-id', 500),
    autoSubmitted: optional('auto-submitted', 100),
    precedence: optional('precedence', 100),
  };
}
