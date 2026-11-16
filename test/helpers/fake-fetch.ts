import type { FetchLike } from '../../src/providers/http.js';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (request: RecordedRequest, index: number) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch double that records requests and replays scripted responses in order. */
export function scriptedFetch(responders: Array<Responder | Response | Error>) {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const text = typeof init.body === 'string' ? init.body : '';
    const request: RecordedRequest = {
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      body: text ? JSON.parse(text) : undefined,
    };
    const index = requests.length;
    requests.push(request);
    const next = responders[Math.min(index, responders.length - 1)];
    if (!next) throw new Error('No scripted response');
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next.clone();
    return next(request, index);
  };
  return { fetch, requests };
}

export const noSleep = async () => {};
