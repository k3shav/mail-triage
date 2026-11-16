import { z } from 'zod';
import type { FieldDecision, ProviderDecision } from '../core/decision.js';
import { prepareEmailForModel } from '../core/email.js';
import { UNTRUSTED_EMAIL_NOTICE, buildQuestions, emailAsData, readerContext, type QuestionSpec } from '../core/prompt.js';
import type { FieldName } from '../core/taxonomy.js';
import { ProviderError } from './errors.js';
import { DEFAULT_HTTP_POLICY, postJson, type HttpDeps, type HttpPolicy } from './http.js';
import type { ClassifierProvider, ClassifyRequest, ProviderInfo } from './types.js';
import { validateChoiceAnswer } from './validate.js';

/**
 * Direct adapter for the OpenAI Decisions API.
 * Reference: https://developers.openai.com/api/docs/guides/decisions
 *   POST /v1/decisions
 *   { model: "gpt-6-luna", input, questions: [{ type: "choice", name, instructions, choices: [{ value, description }] }] }
 *   -> { model, answers: [ { type: "choice", name, choice, confidence, probabilities: [{ value, probability }] }
 *                        | { type: "refusal", name } ], usage }
 */

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-6-luna';

export interface OpenAIDecisionsOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
  policy?: Partial<HttpPolicy>;
  deps?: HttpDeps;
}

const OpenAIDecisionResponseSchema = z.object({
  model: z.string(),
  answers: z.array(z.unknown()),
  usage: z
    .object({ input_tokens: z.number().int().optional(), output_tokens: z.number().int().optional() })
    .partial()
    .optional(),
});

export function buildOpenAIDecisionRequest(request: ClassifyRequest, model: string) {
  const email = prepareEmailForModel(request.email);
  const questions = buildQuestions(request.taxonomy);
  return {
    questions,
    body: {
      model,
      input: [
        {
          role: 'developer',
          content: `${UNTRUSTED_EMAIL_NOTICE}\n\nReader context (written by the reader, trusted): ${readerContext(request.taxonomy)}`,
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'The email to classify, as JSON data:' },
            { type: 'input_json', data: { email: emailAsData(email) } },
          ],
        },
      ],
      questions: questions.map((question) => ({
        type: 'choice',
        name: question.name,
        instructions: question.instructions,
        choices: question.options.map((option) => ({ value: option.value, description: option.description })),
      })),
    },
  };
}

function parseProbabilities(value: unknown): { map: Map<string, unknown> | null; error?: string } {
  if (!Array.isArray(value)) return { map: null, error: 'probabilities are not an array' };
  const map = new Map<string, unknown>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return { map: null, error: 'probability entry is not an object' };
    const { value: optionValue, probability } = entry as Record<string, unknown>;
    if (typeof optionValue !== 'string') return { map: null, error: 'probability value is not a string' };
    if (map.has(optionValue)) return { map: null, error: 'probabilities list an option twice' };
    map.set(optionValue, probability);
  }
  return { map };
}

function parseOpenAIAnswer(answer: unknown, question: QuestionSpec): FieldDecision {
  if (answer === undefined) return { status: 'invalid', reason: 'answer is missing' };
  const record = answer as Record<string, unknown>;
  if (record.type === 'refusal') return { status: 'refused' };
  if (record.type !== 'choice') return { status: 'invalid', reason: 'answer type is not choice' };
  const { map, error } = parseProbabilities(record.probabilities);
  return validateChoiceAnswer(question, {
    choice: record.choice,
    confidence: record.confidence,
    probabilities: map,
    probabilityError: error,
  });
}

/** Match by name; fall back to position for unnamed (name: null) answers, which the API returns in question order. */
function findAnswer(answers: unknown[], question: QuestionSpec, index: number): unknown {
  const named = answers.find(
    (answer) => answer && typeof answer === 'object' && (answer as Record<string, unknown>).name === question.name,
  );
  if (named !== undefined) return named;
  const positional = answers[index];
  if (positional && typeof positional === 'object' && (positional as Record<string, unknown>).name === null) {
    return positional;
  }
  return undefined;
}

export function parseOpenAIDecisionResponse(json: unknown, questions: QuestionSpec[], requestedModel: string): ProviderDecision {
  const parsed = OpenAIDecisionResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ProviderError({
      provider: 'openai-decisions',
      kind: 'malformed_response',
      message: 'OpenAI response did not match the Decisions schema',
    });
  }
  const answers = parsed.data.answers.filter((answer) => answer !== null && typeof answer === 'object');
  const fields = Object.fromEntries(
    questions.map((question, index) => [question.name, parseOpenAIAnswer(findAnswer(answers, question, index), question)]),
  ) as Record<FieldName, FieldDecision>;
  return {
    provider: 'openai-decisions',
    requestedModel,
    model: parsed.data.model,
    confidenceKind: 'provider',
    fields,
    usage: {
      inputTokens: parsed.data.usage?.input_tokens ?? null,
      outputTokens: parsed.data.usage?.output_tokens ?? null,
    },
  };
}

export class OpenAIDecisionsProvider implements ClassifierProvider {
  readonly info: ProviderInfo;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly policy: HttpPolicy;
  private readonly deps: HttpDeps | undefined;

  constructor(options: OpenAIDecisionsOptions) {
    if (!options.apiKey) {
      throw new ProviderError({ provider: 'openai-decisions', kind: 'not_configured', message: 'OPENAI_API_KEY is not set' });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.headers = {};
    if (options.organization) this.headers['openai-organization'] = options.organization;
    if (options.project) this.headers['openai-project'] = options.project;
    this.policy = { ...DEFAULT_HTTP_POLICY, ...options.policy };
    this.deps = options.deps;
    this.info = {
      provider: 'openai-decisions',
      model: options.model ?? OPENAI_DEFAULT_MODEL,
      confidenceKind: 'provider',
      endpointHost: new URL(this.baseUrl).host,
      sendsEmailOffDevice: true,
    };
  }

  async classify(request: ClassifyRequest): Promise<ProviderDecision> {
    const { body, questions } = buildOpenAIDecisionRequest(request, this.info.model);
    const json = await postJson({
      provider: 'openai-decisions',
      url: `${this.baseUrl}/decisions`,
      headers: { authorization: `Bearer ${this.apiKey}`, ...this.headers },
      body,
      policy: this.policy,
      deps: this.deps,
      signal: request.signal,
    });
    return parseOpenAIDecisionResponse(json, questions, this.info.model);
  }
}
