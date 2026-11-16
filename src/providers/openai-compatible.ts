import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError, Output, RetryError, generateText } from 'ai';
import { z } from 'zod';
import type { FieldDecision, ProviderDecision } from '../core/decision.js';
import { prepareEmailForModel } from '../core/email.js';
import { UNTRUSTED_EMAIL_NOTICE, buildQuestions, emailAsData, optionIdForValue, readerContext, type QuestionSpec } from '../core/prompt.js';
import type { FieldName } from '../core/taxonomy.js';
import { ProviderError, type ProviderErrorKind } from './errors.js';
import type { FetchLike } from './http.js';
import type { ClassifierProvider, ClassifyRequest, ProviderInfo } from './types.js';

/**
 * Language-model path for local or compatible servers (Ollama, LM Studio, ...)
 * through the Vercel AI SDK OpenAI-compatible provider and structured output.
 * Reference: https://ai-sdk.dev/providers/openai-compatible-providers
 *
 * Language models do not return a calibrated confidence for this task, so
 * confidence and probabilities are always null here. Self-reported
 * certainty is not requested and would not be treated as confidence.
 */

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Send a JSON schema response_format. Disable for servers that reject it. */
  structuredOutputs?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: FetchLike;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

function enumOf(question: QuestionSpec) {
  const values = question.options.map((option) => option.value);
  return z.enum(values as [string, ...string[]]);
}

export function buildOutputSchema(questions: QuestionSpec[]) {
  const byName = Object.fromEntries(questions.map((question) => [question.name, question])) as Record<FieldName, QuestionSpec>;
  return z.object({
    category: enumOf(byName.category).describe(byName.category.instructions),
    action: enumOf(byName.action).describe(byName.action.instructions),
    priority: enumOf(byName.priority).describe(byName.priority.instructions),
  });
}

export function buildInstructions(questions: QuestionSpec[], context: string): string {
  const sections = questions.map((question) => {
    const options = question.options.map((option) => `  - "${option.value}": ${option.description}`).join('\n');
    return `${question.name}: ${question.instructions}\n${options}`;
  });
  return [
    'You classify one email for a single reader. Answer with JSON only, using exactly the allowed values.',
    UNTRUSTED_EMAIL_NOTICE,
    `Reader context (written by the reader, trusted): ${context}`,
    'Fields:',
    ...sections,
  ].join('\n\n');
}

function mapError(error: unknown): ProviderError {
  const provider = 'openai-compatible' as const;
  const attempts = RetryError.isInstance(error) ? error.errors.length : 1;
  const root = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(root)) {
    const status = root.statusCode;
    let kind: ProviderErrorKind = 'network';
    if (status === 401 || status === 403) kind = 'auth';
    else if (status === 429) kind = 'rate_limited';
    else if (status === 408) kind = 'timeout';
    else if (status !== undefined && status >= 500) kind = 'server';
    else if (status !== undefined) kind = 'bad_request';
    return new ProviderError({
      provider,
      kind,
      status,
      retryable: root.isRetryable,
      attempts,
      message: status ? `Model server returned HTTP ${status}` : 'Could not reach the model server',
    });
  }
  if (NoObjectGeneratedError.isInstance(root) || NoOutputGeneratedError.isInstance(root)) {
    return new ProviderError({ provider, kind: 'invalid_output', attempts, message: 'Model output did not match the required schema' });
  }
  if (root instanceof Error && (root.name === 'TimeoutError' || root.name === 'AbortError')) {
    return new ProviderError({ provider, kind: 'timeout', attempts, message: 'Model request timed out' });
  }
  return new ProviderError({ provider, kind: 'network', attempts, message: 'Model request failed' });
}

export class OpenAICompatibleProvider implements ClassifierProvider {
  readonly info: ProviderInfo;
  private readonly options: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    if (!options.baseUrl || !options.model) {
      throw new ProviderError({
        provider: 'openai-compatible',
        kind: 'not_configured',
        message: 'OPENAI_COMPATIBLE_BASE_URL and MODEL_NAME are required',
      });
    }
    let host: string;
    try {
      host = new URL(options.baseUrl).host;
    } catch {
      throw new ProviderError({ provider: 'openai-compatible', kind: 'not_configured', message: 'OPENAI_COMPATIBLE_BASE_URL is not a valid URL' });
    }
    this.options = options;
    this.info = {
      provider: 'openai-compatible',
      model: options.model,
      confidenceKind: 'none',
      endpointHost: host,
      sendsEmailOffDevice: !isLoopbackUrl(options.baseUrl),
    };
  }

  async classify(request: ClassifyRequest): Promise<ProviderDecision> {
    const email = prepareEmailForModel(request.email);
    const questions = buildQuestions(request.taxonomy);
    const provider = createOpenAICompatible({
      name: 'mail-triage-compatible',
      baseURL: this.options.baseUrl.replace(/\/+$/, ''),
      apiKey: this.options.apiKey || undefined,
      supportsStructuredOutputs: this.options.structuredOutputs ?? true,
      fetch: this.options.fetch as typeof fetch | undefined,
    });
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    let output: Record<FieldName, string>;
    let model = this.options.model;
    let usage: ProviderDecision['usage'] = null;
    try {
      const result = await generateText({
        model: provider.chatModel(this.options.model),
        instructions: buildInstructions(questions, readerContext(request.taxonomy)),
        prompt: `Email to classify, as JSON data:\n${JSON.stringify({ email: emailAsData(email) })}`,
        output: Output.object({ schema: buildOutputSchema(questions), name: 'email_classification' }),
        temperature: 0,
        maxRetries: this.options.maxRetries ?? 2,
        abortSignal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
      });
      if (result.finishReason === 'content-filter') {
        return this.decision(model, { category: { status: 'refused' }, action: { status: 'refused' }, priority: { status: 'refused' } }, null);
      }
      output = result.output as Record<FieldName, string>;
      model = result.response.modelId || model;
      usage = { inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null };
    } catch (error) {
      if (timeout.aborted && !request.signal?.aborted) {
        throw new ProviderError({ provider: 'openai-compatible', kind: 'timeout', message: `Model request timed out after ${timeoutMs} ms` });
      }
      throw mapError(error);
    }

    const fields = Object.fromEntries(
      questions.map((question): [FieldName, FieldDecision] => {
        const id = optionIdForValue(question, output[question.name]);
        return [
          question.name,
          id
            ? { status: 'answered', value: id, confidence: null, selectedProbability: null, probabilities: null }
            : { status: 'invalid', reason: 'value is not one of the requested options' },
        ];
      }),
    ) as Record<FieldName, FieldDecision>;
    return this.decision(model, fields, usage);
  }

  private decision(model: string, fields: Record<FieldName, FieldDecision>, usage: ProviderDecision['usage']): ProviderDecision {
    return {
      provider: 'openai-compatible',
      requestedModel: this.options.model,
      model,
      confidenceKind: 'none',
      fields,
      usage,
    };
  }
}
