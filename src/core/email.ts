import { z } from 'zod';

/** Upper bound on body text sent to any model, in characters. */
export const MODEL_BODY_CHAR_LIMIT = 8000;
export const TRUNCATION_MARKER = '\n[... truncated by Mail Triage ...]';

/**
 * The parts of an email a classifier sees. All string fields are untrusted
 * sender-controlled data.
 */
export const EmailForModelSchema = z.object({
  from: z.string().max(1000),
  to: z.string().max(4000).default(''),
  cc: z.string().max(4000).default(''),
  subject: z.string().max(2000),
  date: z.string().max(100).default(''),
  body: z.string().max(200_000),
  signals: z
    .object({
      hasListUnsubscribe: z.boolean().default(false),
      listId: z.string().max(500).nullable().default(null),
      autoSubmitted: z.string().max(100).nullable().default(null),
      precedence: z.string().max(100).nullable().default(null),
    })
    .default({ hasListUnsubscribe: false, listId: null, autoSubmitted: null, precedence: null }),
});
export type EmailForModel = z.infer<typeof EmailForModelSchema>;
export type EmailForModelInput = z.input<typeof EmailForModelSchema>;

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Avoid splitting a surrogate pair at the boundary.
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end) + TRUNCATION_MARKER;
}

/** Normalize whitespace and bound size before the email leaves the process. */
export function prepareEmailForModel(email: EmailForModel): EmailForModel {
  const body = email.body
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    ...email,
    from: email.from.slice(0, 500),
    to: email.to.slice(0, 1000),
    cc: email.cc.slice(0, 1000),
    subject: email.subject.slice(0, 500),
    body: truncateText(body, MODEL_BODY_CHAR_LIMIT),
  };
}
