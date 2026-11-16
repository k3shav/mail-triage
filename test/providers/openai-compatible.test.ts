import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider, isLoopbackUrl } from '../../src/providers/openai-compatible.js';
import { DEFAULT_TAXONOMY, type Taxonomy } from '../../src/core/taxonomy.js';
import { jsonResponse, scriptedFetch } from '../helpers/fake-fetch.js';
import { SAMPLE_EMAIL, TAXONOMY } from '../helpers/sample.js';

function completion(content: string, finishReason = 'stop') {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1763280000,
    model: 'llama3.2:3b',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 300, completion_tokens: 18, total_tokens: 318 },
  };
}

function provider(responses: Parameters<typeof scriptedFetch>[0], maxRetries = 0) {
  const fake = scriptedFetch(responses);
  const llm = new OpenAICompatibleProvider({
    baseUrl: 'http://127.0.0.1:11434/v1/',
    model: 'llama3.2:3b',
    fetch: fake.fetch,
    maxRetries,
    timeoutMs: 5000,
  });
  return { llm, requests: fake.requests };
}

describe('OpenAI-compatible (AI SDK) adapter', () => {
  it('requests schema-constrained output with no tools and maps values to ids without confidence', async () => {
    const { llm, requests } = provider([
      jsonResponse(completion(JSON.stringify({ category: 'Receipt', action: 'No Action', priority: 'Low' }))),
    ]);
    const decision = await llm.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const body = request!.body as Record<string, any>;
    expect(body.model).toBe('llama3.2:3b');
    expect(body.tools).toBeUndefined();
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe('json_schema');
    const schema = body.response_format.json_schema.schema;
    expect(schema.properties.category.enum).toEqual(DEFAULT_TAXONOMY.categories.map((c) => c.name));
    expect(schema.properties.action.enum).toEqual(['Needs Response', 'Needs Action', 'No Action']);
    const system = body.messages.find((m: any) => m.role === 'system');
    expect(system.content).toMatch(/untrusted/);
    expect(system.content).toContain('I lead the platform team at Northwind.');
    expect(system.content).not.toContain('Could you review');

    expect(decision.provider).toBe('openai-compatible');
    expect(decision.confidenceKind).toBe('none');
    expect(decision.fields.category).toEqual({
      status: 'answered',
      value: 'receipt',
      confidence: null,
      selectedProbability: null,
      probabilities: null,
    });
    expect(decision.usage).toEqual({ inputTokens: 300, outputTokens: 18 });
  });

  it('treats output outside the schema as an invalid-output error', async () => {
    const { llm } = provider([jsonResponse(completion(JSON.stringify({ category: 'Urgent', action: 'No Action', priority: 'Low' })))]);
    await expect(llm.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY })).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('treats non-JSON text as an invalid-output error', async () => {
    const { llm } = provider([jsonResponse(completion('Sure! This looks like a receipt.'))]);
    await expect(llm.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY })).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('reports content-filter stops as refusals for every field', async () => {
    const { llm } = provider([jsonResponse(completion('', 'content_filter'))]);
    const decision = await llm.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY });
    expect(decision.fields).toEqual({ category: { status: 'refused' }, action: { status: 'refused' }, priority: { status: 'refused' } });
  });

  it('maps HTTP errors without leaking bodies', async () => {
    const { llm, requests } = provider([jsonResponse({ error: { message: 'model "llama3.2:3b" not found, body: Could you review' } }, 404)]);
    const error = await llm.classify({ email: SAMPLE_EMAIL, taxonomy: TAXONOMY }).catch((e) => e);
    expect(requests).toHaveLength(1);
    expect(error).toMatchObject({ kind: 'bad_request', status: 404 });
    expect(error.message).not.toContain('Could you review');
  });

  it('uses custom category names as the allowed values', async () => {
    const taxonomy: Taxonomy = {
      userContext: '',
      categories: [
        { id: 'travel', name: 'Travel', description: 'Flights, hotels, itineraries.' },
        { id: 'family', name: 'Family', description: 'Messages from relatives.' },
      ],
    };
    const { llm, requests } = provider([jsonResponse(completion(JSON.stringify({ category: 'Travel', action: 'Needs Action', priority: 'High' })))]);
    const decision = await llm.classify({ email: SAMPLE_EMAIL, taxonomy });
    expect((requests[0]!.body as any).response_format.json_schema.schema.properties.category.enum).toEqual(['Travel', 'Family']);
    expect(decision.fields.category).toMatchObject({ value: 'travel' });
  });

  it('knows whether email leaves the machine', () => {
    expect(isLoopbackUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLoopbackUrl('https://models.example.com/v1')).toBe(false);
    expect(provider([]).llm.info.sendsEmailOffDevice).toBe(false);
  });
});
