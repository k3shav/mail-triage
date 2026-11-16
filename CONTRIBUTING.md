# Contributing

Thanks for helping. Mail Triage is small on purpose: one process, one SQLite file, one user.

## Setup

```sh
npm ci
npm run dev        # API :8787 + Vite :5173
npm run typecheck
npm test
npm run build
```

Node.js 22.12+ is required. Tests must not use the network. Fake Google with `test/helpers/fake-google.ts` and model providers with `test/helpers/fake-fetch.ts` or `ScriptedModel`.

## Ground rules

These rules are design constraints, not style preferences. A change that breaks one needs a strong reason in the pull request.

- **No new Gmail write paths.** The Gmail client may only create labels and add label IDs to a single message, and only from a previewed, explicitly applied action. Do not add send, delete, trash, archive, label removal, read-state changes, or bulk apply.
- **Email is untrusted data.** Never put email content into instructions, never give a model tools, and render bodies as text only. Do not add HTML rendering or remote content loading.
- **Do not invent confidence.** If a provider does not report confidence, store `null`. Do not turn self-reported scores from language models into confidence values.
- **Secrets stay on the server.** Never send tokens, API keys, or client secrets to the browser or write them to logs. Error messages from providers and Google keep only status codes and short error codes, because response bodies can echo email content.
- **Stale means stale.** Anything that changes what the model is asked must change the taxonomy hash (`PROMPT_VERSION` or the taxonomy) so that older decisions cannot be applied.
- **Bounded everything.** New loops over mail, network reads, or request bodies need explicit limits.

## Provider adapters

Adapters live in `src/providers/`. Each one needs:

- a request builder whose output matches the provider's published request format,
- strict response validation that marks bad answers `invalid` instead of fixing them,
- contract tests built from the provider's documented examples (see `test/fixtures/providers/`),
- tests for refusals, malformed bodies, 4xx with no retry, and bounded 429/5xx retries.

Cite the documentation you used in the adapter header and in `docs/research.md`. Do not claim a provider was tested live unless it was, and say when.

## Pull requests

Keep pull requests focused. Every pull request must pass `npm run typecheck`, `npm test`, and `npm run build` (CI runs the same commands). For UI changes, include a screenshot of the demo inbox. Do not use real mail in screenshots.
