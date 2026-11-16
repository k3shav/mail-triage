import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QuestionSpec } from '../../src/core/prompt.js';
import { ProviderError } from '../../src/providers/errors.js';
import { JevProvider, parseJevResponse } from '../../src/providers/jev.js';
import { jsonResponse, noSleep, scriptedFetch } from '../helpers/fake-fetch.js';
import { SAMPLE_EMAIL, TAXONOMY, jevAnswers } from '../helpers/sample.js';

function provider(responses: Parameters<typeof scriptedFetch>[0], maxRetries = 2) {
  const fake = scriptedFetch(responses);
  const jev = new JevProvider({
    apiKey: 'test-jev-key',
    policy: { maxRetries, timeoutMs: 1000 },
    deps: { fetch: fake.fetch, sleep: noSleep, random: () => 0.5 },
  });
  return { jev, requests: fake.requests };
}

describe('Jev System One wire contract', () => {
  it('sends a keyed choice question map with criteria and structured state', async () => {
    const { jev, requests } = provider([jsonResponse(jevAnswers())]);
    await jev.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request!.method).toBe('POST');
    expect(request!.headers.authorization).toBe('Bearer test-jev-key');
    const body = request!.body as Record<string, any>;
    expect(body.model).toBe('jev-latest');
    expect(Object.keys(body.questions)).toEqual(['category', 'action', 'priority']);
    expect(body.questions.category.type).toBe('choice');
    expect(body.questions.category.criteria).toMatchObject({
      FYI: expect.stringContaining('updates'),
      Receipt: expect.stringContaining('Receipts'),
      Other: expect.any(String),
    });
    expect(Object.keys(body.questions.category.criteria)).toHaveLength(7);
    expect(body.questions.action.criteria).toHaveProperty('Needs Response');
    expect(body.questions.priority.criteria).toHaveProperty('High');
    expect(body.state.reader_context).toBe('I lead the platform team at Northwind.');
    expect(body.state.email.subject).toBe('Contract review');
    expect(body.state.notice).toMatch(/untrusted/);
  });

  it('maps answers to ids and keeps confidence distinct from the selected probability', async () => {
    const { jev } = provider([jsonResponse(jevAnswers())]);
    const decision = await jev.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });

    expect(decision.provider).toBe('jev');
    expect(decision.requestedModel).toBe('jev-latest');
    expect(decision.model).toBe('jev-1.13.0');
    expect(decision.confidenceKind).toBe('provider');
    expect(decision.fields.category).toMatchObject({ status: 'answered', value: 'fyi', confidence: 0.82, selectedProbability: 0.88 });
    expect(decision.fields.action).toMatchObject({ status: 'answered', value: 'needs_response', confidence: 0.64, selectedProbability: 0.76 });
    expect(decision.fields.priority).toMatchObject({ value: 'high' });
    const category = decision.fields.category;
    if (category.status !== 'answered') throw new Error('expected answer');
    expect(category.probabilities).toHaveProperty('marketing');
    expect(decision.usage).toEqual({ inputTokens: 410, outputTokens: 30 });
  });

  it('parses the documented Choice response example verbatim', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/providers/jev-choice-docs.json', import.meta.url), 'utf8'));
    const question: QuestionSpec = {
      name: 'category',
      instructions: 'Which team should handle this?',
      options: [
        { id: 'returns', value: 'returns', description: 'Exchanges, wrong or damaged items' },
        { id: 'shipping', value: 'shipping', description: 'Delivery status, delays, lost packages' },
        { id: 'billing', value: 'billing', description: 'Charges, invoices, payment problems' },
      ],
    };
    const renamed = { ...fixture, answers: { category: fixture.answers.department } };
    const decision = parseJevResponse(renamed, [question], 'jev-latest');
    expect(decision.fields.category).toEqual({
      status: 'answered',
      value: 'returns',
      confidence: 1,
      selectedProbability: 1,
      probabilities: { shipping: 0, returns: 1, billing: 0 },
    });
  });

  it.each([
    ['confidence above 1', { confidence: 1.4 }, /confidence/],
    ['negative confidence', { confidence: -0.1 }, /confidence/],
    ['string confidence', { confidence: '0.9' }, /confidence/],
    ['missing confidence', { confidence: undefined }, /confidence is missing/],
    ['unknown choice', { choice: 'Spam' }, /not one of the requested options/],
    ['probabilities that do not sum to 1', { probabilities: { 'Needs Response': 0.9, 'Needs Action': 0.5, 'No Action': 0.1 } }, /sum/],
    ['choice that is not the most probable option', { choice: 'No Action' }, /most probable/],
    ['missing option probability', { probabilities: { 'Needs Response': 0.8, 'Needs Action': 0.2 } }, /cover every/],
    ['wrong answer type', { type: 'score' }, /type/],
  ])('marks %s as invalid without guessing', async (_label, patch, reason) => {
    const base = jevAnswers().answers.action;
    const { jev } = provider([jsonResponse(jevAnswers({ action: { ...base, ...patch } }))]);
    const decision = await jev.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });
    expect(decision.fields.action.status).toBe('invalid');
    if (decision.fields.action.status === 'invalid') expect(decision.fields.action.reason).toMatch(reason);
    expect(decision.fields.category.status).toBe('answered');
  });

  it('marks a missing answer invalid and accepts a defensive refusal shape', async () => {
    const answers = jevAnswers({ priority: { type: 'refusal' } });
    delete (answers.answers as Record<string, unknown>).action;
    const { jev } = provider([jsonResponse(answers)]);
    const decision = await jev.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });
    expect(decision.fields.action).toEqual({ status: 'invalid', reason: 'answer is missing' });
    expect(decision.fields.priority).toEqual({ status: 'refused' });
  });

  it('rejects malformed bodies as contract failures', async () => {
    const nonJson = provider([new Response('<html>gateway</html>', { status: 200 })]);
    await expect(nonJson.jev.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY })).rejects.toMatchObject({ kind: 'malformed_response' });

    const wrongShape = provider([jsonResponse({ answers: [] })]);
    await expect(wrongShape.jev.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY })).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    const sleeps: number[] = [];
    const fake = scriptedFetch([
      jsonResponse({ detail: 'slow down' }, 429, { 'retry-after': '3' }),
      jsonResponse(jevAnswers()),
    ]);
    const jev = new JevProvider({
      apiKey: 'k',
      policy: { maxRetries: 2 },
      deps: { fetch: fake.fetch, sleep: async (ms) => void sleeps.push(ms) },
    });
    const decision = await jev.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });
    expect(decision.fields.category.status).toBe('answered');
    expect(fake.requests).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it('stops after the bounded number of 5xx retries', async () => {
    const { jev, requests } = provider([jsonResponse({ detail: 'down' }, 503)], 2);
    const error = await jev.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'server', status: 503, attempts: 3, retryable: true });
    expect(requests).toHaveLength(3);
  });

  it.each([
    [401, 'auth'],
    [400, 'bad_request'],
    [422, 'bad_request'],
  ])('does not retry HTTP %i', async (status, kind) => {
    const { jev, requests } = provider([
      jsonResponse({ detail: [{ loc: ['body', 'state'], msg: 'bad', type: 'missing', input: 'Could you review sections 4 and 7' }] }, status),
    ]);
    const error = await jev.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY }).catch((e) => e);
    expect(error).toMatchObject({ kind, status });
    expect(requests).toHaveLength(1);
    // Provider error bodies can echo input; messages must not.
    expect(error.message).not.toContain('sections 4 and 7');
    expect(error.message).not.toContain('test-jev-key');
  });

  it('times out slow requests and retries them within the bound', async () => {
    const hang = (_request: unknown, _index: number) =>
      new Promise<Response>((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 5);
      });
    const fake = scriptedFetch([hang]);
    const jev = new JevProvider({ apiKey: 'k', policy: { maxRetries: 1, timeoutMs: 1 }, deps: { fetch: fake.fetch, sleep: noSleep } });
    await expect(jev.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY })).rejects.toMatchObject({ kind: 'timeout', attempts: 2 });
    expect(fake.requests).toHaveLength(2);
  });

  it('refuses to construct without an API key', () => {
    expect(() => new JevProvider({ apiKey: '' })).toThrow(/JEV_API_KEY/);
  });
});
