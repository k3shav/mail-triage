import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QuestionSpec } from '../../src/core/prompt.js';
import { OpenAIDecisionsProvider, parseOpenAIDecisionResponse } from '../../src/providers/openai-decisions.js';
import { jsonResponse, noSleep, scriptedFetch } from '../helpers/fake-fetch.js';
import { SAMPLE_EMAIL, TAXONOMY, openAIAnswers } from '../helpers/sample.js';

function provider(responses: Parameters<typeof scriptedFetch>[0]) {
  const fake = scriptedFetch(responses);
  const openai = new OpenAIDecisionsProvider({
    apiKey: 'sk-test-openai',
    project: 'proj_123',
    policy: { maxRetries: 2, timeoutMs: 1000 },
    deps: { fetch: fake.fetch, sleep: noSleep, random: () => 0 },
  });
  return { openai, requests: fake.requests };
}

describe('OpenAI Decisions wire contract', () => {
  it('posts named choice questions with value/description choices to /v1/decisions', async () => {
    const { openai, requests } = provider([jsonResponse(openAIAnswers())]);
    await openai.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });

    const [request] = requests;
    expect(request!.url).toBe('https://api.openai.com/v1/decisions');
    expect(request!.headers.authorization).toBe('Bearer sk-test-openai');
    expect(request!.headers['openai-project']).toBe('proj_123');
    const body = request!.body as Record<string, any>;
    expect(body.model).toBe('gpt-6-luna');
    expect(body.questions.map((q: any) => [q.type, q.name])).toEqual([
      ['choice', 'category'],
      ['choice', 'action'],
      ['choice', 'priority'],
    ]);
    expect(body.questions[0].choices).toHaveLength(7);
    expect(body.questions[0].choices[0]).toEqual({ value: 'FYI', description: expect.any(String) });
    expect(body.questions[1].choices.map((c: any) => c.value)).toEqual(['Needs Response', 'Needs Action', 'No Action']);
    // Email is passed as JSON data in a user message; the notice and reader context are developer text.
    expect(body.input[0]).toMatchObject({ role: 'developer' });
    expect(body.input[0].content).toContain('I lead the platform team at Northwind.');
    expect(body.input[1].role).toBe('user');
    expect(body.input[1].content[1]).toMatchObject({ type: 'input_json', data: { email: { subject: 'Contract review' } } });
    expect(body.input[0].content).not.toContain('Could you review');
  });

  it('maps array probabilities and keeps confidence separate from selected probability', async () => {
    const { openai } = provider([jsonResponse(openAIAnswers())]);
    const decision = await openai.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });
    expect(decision.provider).toBe('openai-decisions');
    expect(decision.fields.category).toMatchObject({ value: 'meeting', confidence: 0.87, selectedProbability: 0.91 });
    expect(decision.fields.priority).toMatchObject({ value: 'normal', confidence: 0.55, selectedProbability: 0.7 });
    expect(decision.usage).toEqual({ inputTokens: 512, outputTokens: 0 });
  });

  it('parses the documented choice excerpt verbatim', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/providers/openai-choice-docs.json', import.meta.url), 'utf8'));
    const question: QuestionSpec = {
      name: 'department' as never,
      instructions: 'Which department should handle this complaint?',
      options: ['billing', 'technical', 'shipping', 'other'].map((value) => ({ id: value, value, description: value })),
    };
    const decision = parseOpenAIDecisionResponse(fixture, [question], 'gpt-6-luna');
    expect((decision.fields as Record<string, unknown>).department).toEqual({
      status: 'answered',
      value: 'billing',
      confidence: 0.93,
      selectedProbability: 0.95,
      probabilities: { billing: 0.95, technical: 0.02, shipping: 0.01, other: 0.02 },
    });
  });

  it('keeps other answers when one question is refused', async () => {
    const { openai } = provider([jsonResponse(openAIAnswers({ action: { type: 'refusal', name: 'action' } }))]);
    const decision = await openai.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });
    expect(decision.fields.action).toEqual({ status: 'refused' });
    expect(decision.fields.category.status).toBe('answered');
    expect(decision.fields.priority.status).toBe('answered');
  });

  it('matches an unnamed refusal by position', async () => {
    const { openai } = provider([jsonResponse(openAIAnswers({ priority: { type: 'refusal', name: null } }))]);
    const decision = await openai.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });
    expect(decision.fields.priority).toEqual({ status: 'refused' });
  });

  it.each([
    ['boolean choice value', { choice: true }, /not a string/],
    ['NaN-like confidence', { confidence: null }, /confidence is missing/],
    ['confidence above 1', { confidence: 2 }, /confidence/],
    [
      'duplicate probability entries',
      {
        probabilities: [
          { value: 'Low', probability: 0.5 },
          { value: 'Low', probability: 0.5 },
        ],
      },
      /twice/,
    ],
    ['probabilities as an object', { probabilities: { Low: 0.2, Normal: 0.7, High: 0.1 } }, /not an array/],
    ['probability above 1', { probabilities: [{ value: 'Low', probability: 1.5 }, { value: 'Normal', probability: 0 }, { value: 'High', probability: 0 }] }, /probability/],
  ])('marks %s invalid', async (_label, patch, reason) => {
    const base = openAIAnswers().answers[2] as Record<string, unknown>;
    const { openai } = provider([jsonResponse(openAIAnswers({ priority: { ...base, ...patch } }))]);
    const decision = await openai.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });
    expect(decision.fields.priority.status).toBe('invalid');
    if (decision.fields.priority.status === 'invalid') expect(decision.fields.priority.reason).toMatch(reason);
  });

  it('treats an answers array missing a question as invalid for that question', async () => {
    const response = openAIAnswers();
    response.answers = response.answers.slice(0, 2);
    const { openai } = provider([jsonResponse(response)]);
    const decision = await openai.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });
    expect(decision.fields.priority).toEqual({ status: 'invalid', reason: 'answer is missing' });
  });

  it('rejects a keyed answers map (Jev shape) as malformed', async () => {
    const { openai } = provider([jsonResponse({ model: 'gpt-6-luna', answers: { category: {} } })]);
    await expect(openai.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY })).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('retries 500 and 429 within the bound and reports safe error codes', async () => {
    const { openai, requests } = provider([
      jsonResponse({ error: { message: 'Overloaded: Could you review sections 4', type: 'server_error', code: null } }, 500),
      jsonResponse({ error: { message: 'Rate limit', type: 'requests', code: 'rate_limit_exceeded' } }, 429),
      jsonResponse({ error: { message: 'Rate limit', type: 'requests', code: 'rate_limit_exceeded' } }, 429),
    ]);
    const error = await openai.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY }).catch((e) => e);
    expect(requests).toHaveLength(3);
    expect(error).toMatchObject({ kind: 'rate_limited', status: 429, attempts: 3 });
    expect(error.message).toBe('Provider returned HTTP 429 (rate_limit_exceeded)');
  });

  it('does not retry authentication failures', async () => {
    const { openai, requests } = provider([jsonResponse({ error: { message: 'Incorrect API key sk-test-openai', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401)]);
    const error = await openai.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY }).catch((e) => e);
    expect(requests).toHaveLength(1);
    expect(error).toMatchObject({ kind: 'auth' });
    expect(error.message).not.toContain('sk-test-openai');
  });
});
