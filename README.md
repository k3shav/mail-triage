# Mail Triage

An open-source, Gmail-first email classifier for your Mac or a self-hosted server. Custom categories, separate action decisions, and explicit review before mailbox labels change.

Implementation is in progress on a stack of pull requests. This branch adds the Gmail runtime: SQLite storage, Gmail OAuth, bounded sync, label preview/apply, an HTTP API, and a CLI. The web UI lands in the next branch.

## Classifier core

- **Category** (configurable; defaults FYI, Marketing, Comment, Notification, Receipt, Meeting, Other), **action** (Needs Response, Needs Action, No Action), and **priority** (Low, Normal, High) are separate questions.
- Adapters: [Jev System One](https://docs.typesafe.ai/api/system-one.md) and [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) over their native HTTP endpoints, and the [Vercel AI SDK OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers) for Ollama, LM Studio, or another compatible server.
- Provider confidence is stored separately from the selected option's probability. Language models via the compatible adapter report no confidence; nothing is estimated in its place.
- Refused, invalid, unscored, and low-confidence answers go to human review.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run classify -- --demo          # bundled fixture labels, no model call
MODEL_PROVIDER=jev JEV_API_KEY=... npm run classify -- email.json
```

See [docs/research.md](docs/research.md) for sources, adjacent projects, and the provider contracts.

## Gmail runtime

```sh
npm run build && npm start          # API on http://127.0.0.1:8787 (loopback, local session)
npm run cli -- status
npm run cli -- sync                 # newest inbox messages, bounded by SYNC_MAX_MESSAGES
npm run cli -- classify [--demo]    # messages without a decision for the current configuration
```

- Gmail access uses a Google **Web application** OAuth client with an exact redirect URI (`<PUBLIC_URL>/api/gmail/oauth/callback`). State is random, single-use, expires after 10 minutes, and is tied to the browser session.
- Only `gmail.readonly` is requested unless `GMAIL_LABEL_WRITES=true`, which adds `gmail.labels` and `gmail.modify`. Granted scopes are stored; applying is disabled without `gmail.modify`.
- Refresh tokens are AES-256-GCM encrypted with `MAIL_TRIAGE_ENCRYPTION_KEY`; access tokens stay in memory.
- Labels are applied per message from a preview bound to account, Gmail message id, configuration revision, decision revision, and provider/model. Stale previews are rejected. Labels are only added, never removed.
- `APP_PASSWORD` (12+ characters) is required whenever the app is reachable from anywhere but this machine: a non-loopback `HOST`, a non-loopback `PUBLIC_URL` (for example a reverse proxy forwarding `https://mail.example.com` to `127.0.0.1`), or `TRUST_PROXY=true`. Password-free local sessions exist only for loopback-only setups. All API calls need a session, and state changes need same-origin + CSRF token.
- Sync reads at most 4 MiB per `format=full` Gmail message response (2 MiB for other Gmail responses, 64 KiB for error bodies), streaming and cancelling past the limit. A larger message is skipped and counted in `failed`; the rest of the sync continues.
- Sync and classify runs hold a per-mailbox SQLite lease (2 minutes, renewed every 20 seconds while the run is alive), so the server and a cron CLI never overlap. If another process takes the lease over, for example after this one was suspended, the run stops, its pending results are discarded, and it fails with `409 lease_lost`.
- A model answer is stored only if the message's decision and the configuration are unchanged since the request started. A correction made while the model is running is kept; the late answer is discarded and counted as `superseded`.

### Reviewing decisions over HTTP

Every message's `decision` includes `taxonomyRevision`, `decisionSeq`, `source` (`model`, `human`, or `null`), and `sourceId`. Corrections echo the first two back so they apply only to what the reviewer saw:

```jsonc
// POST /api/mailboxes/:mailbox/messages/:id/corrections
// Accept the current model classification; its values are stored.
{ "kind": "accept", "expectedTaxonomyRevision": 3, "expectedDecisionSeq": 5, "basedOnClassificationId": 42 }
// Optional "category"/"action"/"priority" on an accept must equal the classification's values.

// Edit: set the values explicitly. basedOnClassificationId is optional (null by default).
{ "kind": "edit", "expectedTaxonomyRevision": 3, "expectedDecisionSeq": 5,
  "category": "receipt", "action": "no_action", "priority": "low", "basedOnClassificationId": 42 }
```

For an accept, `basedOnClassificationId` is `decision.sourceId` while `decision.source` is `"model"`. Errors: `409 stale_revision` (configuration changed; `details.current`), `409 stale_decision` (another classification or correction landed; `details.currentDecisionSeq`), `409 classification_mismatch` (the id is not a current-revision classification of this message), `409 not_acceptable` (not the current model decision, or it has refused or invalid answers; edit instead), `409 accept_mismatch` (sent values differ; `details.field`, `details.expected`), `400 unknown_category`, `400 invalid_request` (missing or unknown fields). Success returns the message detail.

`POST /api/mailboxes/:mailbox/messages/:id/classify` returns the message detail plus `outcome: "classified" | "superseded"`. `POST /api/mailboxes/:mailbox/classify` returns `{ attempted, classified, needsReview, failed, superseded, remaining, stoppedEarly }`, where `attempted = classified + failed + superseded`.
