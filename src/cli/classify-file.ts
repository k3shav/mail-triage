import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { classifyEmail } from '../core/classify.js';
import { DEFAULT_REVIEW_POLICY } from '../core/decision.js';
import { EmailForModelSchema } from '../core/email.js';
import { DEFAULT_TAXONOMY, FIELD_NAMES, TaxonomySchema, optionName, type Taxonomy } from '../core/taxonomy.js';
import { DEMO_MESSAGES } from '../demo/fixtures.js';
import { describeError } from '../providers/errors.js';
import { FixtureProvider } from '../providers/fixture.js';
import { createProviderFromEnv } from '../providers/registry.js';
import type { ClassificationOutcome } from '../core/classify.js';

const USAGE = `Usage:
  npm run classify -- --demo                     Show hand-written fixture answers for the bundled sample emails (no model, no credentials)
  npm run classify -- <email.json> [--taxonomy <taxonomy.json>]
                                                 Classify one email with the model set by MODEL_PROVIDER

email.json: { "from", "subject", "body", "to"?, "cc"?, "date"? }
taxonomy.json: { "categories": [{ "id", "name", "description" }], "userContext"? }`;

function summarize(taxonomy: Taxonomy, outcome: ClassificationOutcome): string {
  const parts = FIELD_NAMES.map((field) => {
    const result = outcome.decision.fields[field];
    if (result.status === 'refused') return `${field}=REFUSED`;
    if (result.status === 'invalid') return `${field}=INVALID(${result.reason})`;
    const name = optionName(taxonomy, field, result.value) ?? result.value;
    const confidence = result.confidence === null ? 'no confidence' : `confidence ${result.confidence.toFixed(2)}`;
    const probability = result.selectedProbability === null ? '' : `, p=${result.selectedProbability.toFixed(2)}`;
    return `${field}=${name} (${confidence}${probability})`;
  });
  const review = outcome.needsReview ? `\n    review: ${outcome.reviewReasons.map((r) => r.message).join('; ')}` : '';
  return `${parts.join('  ')}${review}`;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      demo: { type: 'boolean', default: false },
      taxonomy: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || (!values.demo && positionals.length !== 1)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const taxonomy = values.taxonomy
    ? TaxonomySchema.parse(JSON.parse(await readFile(values.taxonomy, 'utf8')))
    : DEFAULT_TAXONOMY;

  if (values.demo) {
    const provider = new FixtureProvider();
    console.log('Demo fixtures: hand-written answers for fictional sample emails, not model output. Nothing touches Gmail.\n');
    for (const demo of DEMO_MESSAGES) {
      const outcome = await classifyEmail({ provider, email: demo.email, taxonomy, policy: DEFAULT_REVIEW_POLICY, messageKey: demo.key });
      console.log(`${demo.email.subject}\n    ${summarize(taxonomy, outcome)}`);
    }
    return 0;
  }

  const setup = createProviderFromEnv(process.env);
  if (!setup.provider) {
    console.error(`Model not configured: ${setup.status.configured ? '' : setup.status.reason}`);
    return 1;
  }
  const email = EmailForModelSchema.parse(JSON.parse(await readFile(positionals[0]!, 'utf8')));
  const outcome = await classifyEmail({ provider: setup.provider, email, taxonomy, policy: DEFAULT_REVIEW_POLICY });
  if (values.json) console.log(JSON.stringify(outcome, null, 2));
  else console.log(`${setup.provider.info.provider} ${outcome.decision.model}\n    ${summarize(taxonomy, outcome)}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(describeError(error));
    process.exit(1);
  },
);
