# Research and implementation decisions

Checked 16 November 2026 against primary project and API documentation.

## Existing projects

This idea already exists in several forms. A new classifier should not claim to be the first.

| Project | Documented scope | Implication for this project |
| --- | --- | --- |
| [Jev Mail Classifier](https://github.com/parth-kp/jev-mail-classifier) | Jev-based inbox classification and config-driven mailbox actions | Closest existing project; users happy with that workflow should evaluate it first. |
| [Inbox Zero](https://github.com/elie222/inbox-zero) | Open-source email client and AI assistant, Gmail/Outlook, plain-language rules, self-hosting | A broader existing option. Mail Triage is a focused single-user background labeler with no inbox UI and fewer services. |

The comparison is documentation-based; neither project was installed or benchmarked for this research. No source code from either project is copied into Mail Triage.

## Models and framework

- [TypeSafe Jev](https://docs.typesafe.ai/introduction) exposes typed decisions rather than generated chat text. Its [System One reference](https://docs.typesafe.ai/api/system-one.md) documents `POST https://api.typesafe.ai/v1/systemone`, shared `state`, named `questions`, and keyed answers. Choice questions specify a `criteria` map. Keep a direct adapter and validate the provider response.
- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) documents `POST /v1/decisions`, shared `input`, and a questions array. At the research date, the documented model is `gpt-6-luna`. Choice questions use `choices` with `value`/`description`; answers are an array matched by question name. Refusals must not turn into a confident classification.
- [Vercel AI SDK](https://ai-sdk.dev/docs/foundations/providers-and-models) abstracts language models. Its [OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers) supports compatible inference servers. Use this path for local Ollama/LM Studio or compatible hosted language models. The chat interface is not a substitute for either provider's dedicated decision endpoint.

Model endpoint availability, account permissions, cost, latency, and classification accuracy require live checks with the operator's credentials and representative labeled mail. Fixture tests establish parsing and request contracts only. A locally running app using Jev or OpenAI still transmits email content to that provider. Fully local inference requires a local model server. Language-model self-reported confidence must not be presented as calibrated provider confidence.

## Taxonomy

Category and action answer different questions. A deployment notification might require action; a marketing email usually does not. Avoid forcing these into mutually exclusive categories.

- Category: FYI, Marketing, Comment, Notification, Receipt, Meeting, Other. Users can change names and plain-language definitions.
- Action: Needs Response, Needs Action, No Action.
- Priority: Low, Normal, High.
- Review: uncertain, refused, or invalid predictions must stay visible as uncertain. In the shipped product they get only a `Needs Review` Gmail label and no guessed category; confidence-less answers from language models are labeled only on explicit opt-in, still with `Needs Review`, and never with an invented confidence.

Configuration revisions must be attached to classifications. Editing a definition must not silently authorize labeling with a stale result. Do not pretend a keyword demo classifies arbitrary mail with AI.

## Gmail and deployment boundaries

The user selected Gmail OAuth as the first connector. [Google's web-server OAuth guidance](https://developers.google.com/identity/protocols/oauth2/web-server) describes offline refresh, exact redirect URIs, and state validation. Use expiring single-use state tied to the initiating session, and keep credentials server-side with refresh tokens encrypted at rest.

[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) distinguish reading messages from editing labels. Applying labels to a message uses [`users.messages.modify`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify), which needs `gmail.modify` (or another documented applicable scope). That grant is broader than the app's intended additive-label operation. Document it honestly. Public distribution can require Google verification; users running their own OAuth project must follow Google's testing/consent rules.

## Product scope revision: background labeler

The first iteration put a separate inbox UI with per-message review and preview/apply in front of Gmail. The user's direction ("I don't want a separate inbox UI - I just want it to tag things on my gmail") replaced that: Gmail stays the only inbox, and Mail Triage runs in the background, adding namespaced labels with `addLabelIds` only. The browser is used once, to connect Gmail.

Consequences:

- Writes are automatic, so the safety checks that a human click used to provide moved into the pipeline: a default dry-run mode that never writes, an explicit `TAGGING_MODE=apply` that also requires `GMAIL_LABEL_WRITES=true` and a granted `gmail.modify`, one renewable owner-checked lease per cycle, and a re-check of the configuration revision, message, thread, and classification immediately before each write.
- Uncertainty must be visible where the user reads mail, so it becomes a Gmail label (`<prefix>/Needs Review`) instead of a review queue.
- It does not change unread state, remove labels, archive, delete, or send. Labels accumulate when categories change; that trade-off is documented rather than solved with removals.
- Polling (default every 120 s, bounded batches) is used instead of Gmail push notifications, which need a Pub/Sub topic and a public endpoint and are out of scope for a single-user MVP.

Never classify or modify the developer's own mailbox during automated verification.

Mac and server runs share one runtime and persistent storage. Loopback is the local default; a remotely reachable setup page requires authentication and HTTPS termination. Running the app locally is not the same as local inference: with Jev or OpenAI, classified email text still goes to that provider. Email bodies are private local data; ignore database files and credentials in Git, and keep message content out of logs and status output.

## Provider wire details used by the adapters

Re-checked 16 November 2026 while implementing `src/providers/`. These are documentation facts; no live request was made to either service.

| | Jev System One | OpenAI Decisions | OpenAI-compatible (AI SDK) |
| --- | --- | --- | --- |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` | `POST https://api.openai.com/v1/decisions` | `POST <base>/chat/completions` via `@ai-sdk/openai-compatible` |
| Model | `jev-latest` alias; response `model` may name a concrete version | `gpt-6-luna` (the only documented model) | Operator-chosen local or hosted model |
| Shared input | `state`: string, object, or array | `input`: string or message array; `input_json` parts carry JSON data in user messages | System instructions plus a user message |
| Questions | Object keyed by name; choice uses `criteria: { option: description }` (1–255) | Array; choice uses `name` and `choices: [{ value, description }]` (2–255) | JSON schema with an enum per field (`Output.object`) |
| Answers | Object keyed by question name: `choice`, `confidence`, `probabilities` map | Array in question order: `choice`, `confidence`, `probabilities` as `[{ value, probability }]`, or `{ type: "refusal", name }` | Generated object; no confidence or probabilities |
| Confidence | Derived from the shape of `probabilities` (1 = all mass on one option, 0 = even split); separate from the selected option's probability | Separate `confidence` field next to the distribution; thresholds should be set from labeled data | None. Stored as null and routed to review by default |

Sources: [System One reference](https://docs.typesafe.ai/api/system-one.md), [Choice](https://docs.typesafe.ai/primitives/choice.md), [Confidence](https://docs.typesafe.ai/confidence.md), [Decisions guide](https://developers.openai.com/api/docs/guides/decisions), [Create a decision reference](https://developers.openai.com/api/reference/resources/decisions/methods/create.md), [AI SDK OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers).

Implementation consequences:

- The Jev reference documents 400/422 error bodies and no refusal answer type. The adapter still accepts `type: "refusal"` defensively and treats any other unexpected answer as invalid.
- OpenAI refusals are per question; other answers in the same response remain usable.
- Validation is strict: a confidence outside 0–1, a choice that was not offered, a choice that is not the most probable option, duplicate or unknown probability keys, or a distribution that does not sum to 1 within 0.02 makes that field invalid. Invalid and refused fields always get only the Needs Review label. Nothing is clamped.
- Error bodies (Jev 422 includes an `input` preview) can echo email text, so error messages keep only HTTP status and short error codes.
- 408, 429, 5xx, timeouts, and network failures retry with bounded exponential backoff (default two retries, `Retry-After` honored up to 8 s). Other 4xx errors fail immediately. The AI SDK path uses the SDK's own bounded `maxRetries`.
- The Vercel AI SDK 7 also ships an experimental `decide` API. This project does not use it for Jev or OpenAI, to keep the request and response contract exactly as each provider documents it.
