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
- Non-loopback binds require `APP_PASSWORD`; all API calls need a session, and state changes need same-origin + CSRF token.
