import { describe, expect, it } from 'vitest';
import { MAX_STORED_BODY_CHARS, decodeHeaderValue, extractBody, extractSignals, htmlToText, type GmailPart } from '../../src/server/gmail/mime.js';

const data = (text: string, encoding: BufferEncoding = 'utf8') => Buffer.from(text, encoding).toString('base64url');
const part = (mimeType: string, body: string, extra: Partial<GmailPart> = {}): GmailPart => ({
  mimeType,
  headers: [{ name: 'Content-Type', value: `${mimeType}; charset=utf-8` }],
  body: { size: body.length, data: data(body) },
  ...extra,
});

describe('MIME body extraction', () => {
  it('prefers text/plain inside multipart/alternative', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/alternative',
      parts: [part('text/plain', 'Plain version'), part('text/html', '<p>HTML version</p>')],
    };
    expect(extractBody(payload)).toEqual({ text: 'Plain version', source: 'plain', truncated: false });
  });

  it('falls back to HTML converted to text without scripts, styles, or remote content', () => {
    const html = `<html><head><title>T</title><style>p{color:red}</style><script>alert(1)</script></head>
      <body><p>Hello&nbsp;<b>Sam</b> &amp; team</p><img src="https://tracker.example/pixel.gif"><ul><li>One</li><li>Two</li></ul>
      <a href="javascript:alert(2)">click</a><!-- hidden --><iframe src="https://x.example"></iframe>&#128512;</body></html>`;
    const result = extractBody({ mimeType: 'multipart/mixed', parts: [part('text/html', html)] });
    expect(result.source).toBe('html');
    expect(result.text).toContain('Hello Sam & team');
    expect(result.text).toContain('• One\n• Two');
    expect(result.text).toContain('click');
    expect(result.text).toContain('😀');
    for (const banned of ['alert', 'tracker.example', 'color:red', 'hidden', '<', 'x.example']) expect(result.text).not.toContain(banned);
  });

  it('skips attachments, including text attachments', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        part('text/plain', 'attached notes', { filename: 'notes.txt' }),
        { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { size: 9000, attachmentId: 'ANGjdJ8' } },
        { mimeType: 'multipart/alternative', parts: [part('text/plain', 'The real body')] },
      ],
    };
    expect(extractBody(payload).text).toBe('The real body');
  });

  it('decodes declared charsets', () => {
    const latin1: GmailPart = {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset="ISO-8859-1"' }],
      body: { data: data('Café crème', 'latin1') },
    };
    expect(extractBody(latin1).text).toBe('Café crème');
  });

  it('caps stored size and strips control characters', () => {
    const big = extractBody(part('text/plain', `start\u0007${'a'.repeat(MAX_STORED_BODY_CHARS + 10)}`));
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBe(MAX_STORED_BODY_CHARS);
    expect(big.text.startsWith('starta')).toBe(true);
  });

  it('bounds nesting depth', () => {
    let payload: GmailPart = part('text/plain', 'deep');
    for (let i = 0; i < 50; i += 1) payload = { mimeType: 'multipart/mixed', parts: [payload] };
    expect(extractBody(payload)).toEqual({ text: '', source: 'none', truncated: false });
  });

  it('decodes RFC 2047 headers and extracts list signals', () => {
    expect(decodeHeaderValue('=?UTF-8?B?w4lsw6h2ZQ==?= =?UTF-8?Q?_r=C3=A9union?=')).toBe('Élève réunion');
    expect(
      extractSignals([
        { name: 'List-Unsubscribe', value: '<mailto:u@example.com>' },
        { name: 'List-Id', value: 'news.example.com' },
        { name: 'Precedence', value: 'bulk' },
      ]),
    ).toEqual({ hasListUnsubscribe: true, listId: 'news.example.com', autoSubmitted: null, precedence: 'bulk' });
  });

  it('handles unterminated tags', () => {
    expect(htmlToText('Hi <b>there</b> <img src="x"')).toBe('Hi there');
  });
});
