# Contributing

Thanks for helping. Mail Triage is small on purpose: a background labeler with one process, one SQLite file, one user, and no inbox UI.

## Setup

```sh
npm ci
npm run dev        # server with tsx watch: setup page + background cycles
npm run typecheck
npm test
npm run build
```

Node.js 22.12+ is required. Tests must not use the network. Fake Google with `test/helpers/fake-google.ts` (its `before` hook can change state or stall while a Gmail call is in flight) and model providers with `test/helpers/fake-fetch.ts` or `ScriptedModel`. Pipeline behavior is tested end to end in `test/server/pipeline.test.ts`.

## Ground rules

These rules are design constraints, not style preferences. A change that breaks one needs a strong reason in the pull request.

- **No new Gmail write paths.** The Gmail client may only create labels under the configured prefix and add label IDs to one message at a time. Do not add send, delete, trash, archive, label removal, read-state changes, or batch modify.
- **Dry-run never writes.** In dry-run mode no code path may create a label or call `messages.modify`.
- **Check before every write.** Gmail writes happen only inside the pipeline's lease, after re-checking (through `lease.commit`) that the categories revision, the message, and its classification are unchanged since they were read. Do not bypass `withLock`, `lease.commit`, or the decision-sequence checks in the store.
- **Uncertain means Needs Review.** Refused, invalid, and low-confidence answers get only the review label; never pick a category for them. Unscored answers are labeled only with `AUTO_LABEL_UNSCORED=true`, and always together with Needs Review.
- **Do not invent confidence.** If a provider does not report confidence, store `null`. Do not turn self-reported scores from language models into confidence values.
- **No email content outside the database.** Logs, cycle summaries, `/api/status`, CLI output, and the setup page carry counts and status only, never subjects, senders, snippets, or bodies. The setup page must not list or render messages.
- **Email is untrusted data.** Never put email content into instructions or give a model tools.
- **Secrets stay on the server.** Never send tokens, API keys, or client secrets to the browser or write them to logs. Error messages from providers and Google keep only status codes and short error codes, because response bodies can echo email content.
- **Stale means stale.** Anything that changes what the model is asked must change the taxonomy hash (`PROMPT_VERSION` or the taxonomy) so that older classifications are not labeled under new categories.
- **Bounded everything.** New loops over mail, network reads, files, or request bodies need explicit limits.
- **Setup page stays CSP-safe.** External script and stylesheet only; no inline scripts, inline styles, or event-handler attributes; no `innerHTML` with server data.

## Provider adapters

Adapters live in `src/providers/`. Each one needs:

- a request builder whose output matches the provider's published request format,
- strict response validation that marks bad answers `invalid` instead of fixing them,
- contract tests built from the provider's documented examples (see `test/fixtures/providers/`),
- tests for refusals, malformed bodies, 4xx with no retry, and bounded 429/5xx retries.

Cite the documentation you used in the adapter header and in `docs/research.md`. Do not claim a provider was tested live unless it was, and say when.

## Pull requests

Keep pull requests focused. Every pull request must pass `npm run typecheck`, `npm test`, and `npm run build` (CI runs the same commands, plus a Docker build and health check). Never use real mail in tests, fixtures, logs, or screenshots.
