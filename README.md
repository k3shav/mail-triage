# Mail Triage

A background Gmail labeler for your Mac or a self-hosted server. It reads new inbox mail, classifies each message into **categories you define**, plus a separate **action** and **priority**, and adds matching labels in Gmail. You keep using Gmail as usual; Mail Triage has no inbox of its own.

```
Mail Triage/Category/Receipt          Mail Triage/Action/Needs Response     Mail Triage/Priority/High
Mail Triage/Category/Notification     Mail Triage/Action/Needs Action       Mail Triage/Priority/Normal
Mail Triage/Category/…                Mail Triage/Action/No Action          Mail Triage/Priority/Low
Mail Triage/Needs Review
```

- **Three separate decisions per message.** The category comes from your own plain-English definitions (defaults: FYI, Marketing, Comment, Notification, Receipt, Meeting, Other). Action (Needs Response, Needs Action, No Action) and priority (Low, Normal, High) are labeled independently, so a deploy alert can be a Notification that Needs Action.
- **Uncertainty shows up in Gmail.** Low-confidence, refused, or invalid answers get only `Mail Triage/Needs Review`, with no guessed category. Open that label in Gmail's sidebar to see them.
- **Additive and namespaced.** Mail Triage only creates labels under its prefix and adds them to messages. It never removes labels, archives, deletes, sends, or changes read state.
- **Dry run first.** The default `TAGGING_MODE=dry-run` syncs and classifies, then reports how many labels *would* be added, without writing anything to Gmail.
- **Decision models with real confidence**: [Jev System One](https://docs.typesafe.ai/api/system-one.md) and [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions). Local models (Ollama, LM Studio) work through an [OpenAI-compatible adapter](https://ai-sdk.dev/providers/openai-compatible-providers). Mail Triage never invents a confidence score.
- **One process, one SQLite file.** A small setup page connects Gmail once; after that, everything runs in the background or from the CLI.

This is a single-user, single-Gmail-account tool. Similar projects exist; see [docs/research.md](docs/research.md) for [Jev Mail Classifier](https://github.com/parth-kp/jev-mail-classifier) and [Inbox Zero](https://github.com/elie222/inbox-zero).

## How it works

Every cycle (every 120 seconds by default, or once per `mail-triage tag`):

1. **Categories**: if `CATEGORIES_FILE` is set, the file is validated and reloaded. An invalid file stops the cycle, and the saved categories stay as they were.
2. **Sync**: list the newest `SYNC_MAX_MESSAGES` inbox messages (default 50) and download only the ones not stored yet. Reading never marks mail as read.
3. **Classify**: send up to `CLASSIFY_BATCH_SIZE` messages (default 20) with no classification for the current categories to the model. Messages already classified are not sent again.
4. **Label**: for up to `TAG_BATCH_SIZE` messages (default 50) whose labels are not in place yet, read the message's current labels from Gmail and add the missing ones.

A message is processed only once per set of categories. Unchanged cycles make no Gmail writes and no model calls. If you remove a Mail Triage label from a message yourself, it is not added back.

## Quick start (Mac)

Requires Node.js 22.12 or newer.

```sh
git clone https://github.com/k3shav/mail-triage.git
cd mail-triage
npm ci
npm run build
cp .env.example .env     # then set a model and the Google client (below)
npm start
```

1. Open http://localhost:8787 and choose **Connect Gmail**. This is the only time you need the browser. The page shows the mode, Gmail and model status, the last cycle's counts, and your categories. It never shows email.
2. Leave `TAGGING_MODE=dry-run` for a while. Check what would happen with `npm run cli -- status` or on the setup page.
3. When the counts look right, set `GMAIL_LABEL_WRITES=true` and `TAGGING_MODE=apply` in `.env`, restart, and choose **Reconnect Gmail** to grant label changes. Labels appear in Gmail within a cycle.

**Try it without any credentials:** `npm run classify -- --demo` prints hand-written fixture answers for twelve fictional sample emails. It calls no model and touches no mailbox.

## Configure a model

Set these in `.env`. Keys stay on the server.

| Provider | Settings | Confidence |
| --- | --- | --- |
| Jev System One | `MODEL_PROVIDER=jev`, `JEV_API_KEY=…` (model `jev-latest` by default) | Reported per answer, plus a probability for each option |
| OpenAI Decisions | `MODEL_PROVIDER=openai`, `OPENAI_API_KEY=…` (model `gpt-6-luna` by default) | Reported per answer, plus a probability for each option; per-question refusals |
| Ollama | `MODEL_PROVIDER=openai-compatible`, `OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1`, `MODEL_NAME=llama3.2` | None |
| LM Studio | `MODEL_PROVIDER=openai-compatible`, `OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234/v1`, `MODEL_NAME=<loaded model>` | None |

**Where your mail goes.** Mail Triage itself runs on your machine or server, and the mail copies it keeps stay in its SQLite file. Classification is a separate question:

- With **Jev or OpenAI**, the sender, recipients, subject, and up to 8,000 characters of body of each classified message are sent to that cloud provider. Running Mail Triage locally does not change that.
- With a **local model server** (Ollama, LM Studio on your machine), email text does not leave your machine except to Gmail itself.

Each message is sent as data with an explicit untrusted-content notice. The model only picks from your options and has no tools. Requests time out after 20 s (60 s for local models). Rate limits, server errors, and network errors get at most two retries.

To check a model on one email: `npm run classify -- path/to/email.json`.

## Gmail OAuth setup

Mail Triage uses Google's [OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server), with an OAuth client in your own Google Cloud project. The client type must be **Web application**: the client secret stays on this server, and Google redirects back to one exact registered URI. **Desktop** (installed app) clients do not work.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Gmail API**.
2. Configure the **OAuth consent screen**: user type External (or Internal for Workspace), publishing status **Testing**, with your own address as a test user.
3. **Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorized redirect URIs**, add exactly
   `http://localhost:8787/api/gmail/oauth/callback`
   (or `<PUBLIC_URL>/api/gmail/oauth/callback` on a server). `npm run cli -- setup` prints the URI for your configuration.
4. In `.env`:

   ```sh
   GOOGLE_CLIENT_ID=….apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   MAIL_TRIAGE_ENCRYPTION_KEY=…   # output of: openssl rand -base64 32
   GMAIL_LABEL_WRITES=false       # true before using apply mode
   ```

5. Run `npm start`, open the app at the same host as the redirect URI (`http://localhost:8787`, not `127.0.0.1`) so the session cookie survives the redirect, and choose **Connect Gmail**.

**Scopes.** With `GMAIL_LABEL_WRITES=false`, only `gmail.readonly` is requested; dry-run works and apply is refused. With `true`, Mail Triage also requests `gmail.labels` (to create its labels) and `gmail.modify` (to add labels to messages). Gmail has no narrower scope for labeling a message, and `gmail.modify` is broad: it allows almost any change short of permanent deletion. Mail Triage's Gmail client has exactly two write methods: create a label, and add label IDs to one message. Google may let you grant only some scopes; Mail Triage records what you granted, and apply mode reports a missing `gmail.modify` instead of pretending to succeed.

**Tokens.** The refresh token is encrypted at rest with AES-256-GCM using `MAIL_TRIAGE_ENCRYPTION_KEY` and bound to the account record. Access tokens live only in memory. No token is sent to the browser or written to logs. If you change the key, reconnect Gmail. **Disconnect** on the setup page revokes the grant with Google and deletes the account and its local mail copies; labels already in Gmail stay.

**Testing mode.** Google may expire refresh tokens for External apps in Testing status after about 7 days. When that happens, cycles stop with "Gmail access was revoked or expired" (after one token request, not one per message); reconnect on the setup page. Publishing an app with Gmail scopes for other people requires Google's verification.

## Categories

Categories, their descriptions, and a short note about you (`userContext`) are what the model is asked about. There are three ways to set them:

- **A JSON file** (recommended): copy [examples/categories.json](examples/categories.json), edit it, and set `CATEGORIES_FILE=./my-categories.json`. It is reloaded before every cycle. See [examples/README.md](examples/README.md) for the format and tips.
- **The CLI**: `mail-triage categories check <file>` validates; `mail-triage categories import <file>` saves it once.
- **The setup page**: edit the JSON in place (disabled when `CATEGORIES_FILE` is set).

Files are read whole and validated strictly (unknown keys are errors). A malformed or invalid file never changes the saved categories. A new revision is created only when the content changes; reformatting the file does nothing.

After a change, messages in the current sync window are classified again under the new categories and get their new labels. Older Mail Triage labels on those messages stay, because nothing is ever removed.

## Labels and review

For each classified message, Mail Triage plans one of these:

| Model answer | Labels added |
| --- | --- |
| All three fields answered with provider confidence ≥ `CONFIDENCE_THRESHOLD` (default 0.7) | Category, Action, Priority |
| Any field below the threshold, refused, or invalid | `Needs Review` only |
| Valid answers with no confidence (local models), `AUTO_LABEL_UNSCORED=false` (default) | `Needs Review` only |
| Valid answers with no confidence, `AUTO_LABEL_UNSCORED=true` | Category, Action, Priority, **and** `Needs Review` |
| The model failed on this message 5 times | `Needs Review` only |

`AUTO_LABEL_UNSCORED` does not invent a confidence and does not record an acceptance; the stored answer keeps a null confidence. The 0.7 threshold is a starting point, not a calibrated value; adjust it after checking labels against your own mail.

Before labeling, Mail Triage re-reads the message from Gmail and checks that the thread still matches. Then every Gmail write request (each label creation and each modify, including retries after rate limits, network errors, or a token refresh) is checked immediately before it is sent: inside one database transaction, Mail Triage verifies that it still holds the mailbox lease and that the account, message, categories, and classification have not changed. If anything changed, nothing more is sent for that message and the next cycle uses the new state. Labels are created on first use, matched by exact name, and reused.

`Needs Review` is a normal Gmail label. Review messages in Gmail, apply your own labels if you like, and remove `Needs Review` when you are done; it will not come back unless the message is classified again (for example after a categories change).

## Running in the background

`npm start` runs the setup page and a cycle every `POLL_INTERVAL_SECONDS` (default 120). A cycle starts only after the previous one finished. Set `POLL_INTERVAL_SECONDS=0` to turn the server's own polling off.

After Gmail is connected, the CLI works headless and shares the same database:

```sh
npm run cli -- status              # mode, model, Gmail, categories, last cycle (counts only)
npm run cli -- tag --dry-run       # one cycle; report what would change
npm run cli -- tag --apply         # one cycle; add labels
npm run cli -- watch --interval 300
npm run cli -- setup               # remaining setup steps, with your redirect URI
```

`--dry-run` and `--apply` override `TAGGING_MODE` and cannot be combined. `--apply` still requires `GMAIL_LABEL_WRITES=true` and the `gmail.modify` grant.

The package also provides a `mail-triage` executable (`npm link` after building). It does not read `.env` by itself; export the variables or use `npm run cli`.

**Exit codes**: `0` the cycle ran (messages that failed are retried later), `1` setup is incomplete or a critical error stopped the cycle (bad categories file, revoked Gmail access, missing permission, provider authentication), `2` usage error, `75` another cycle holds the mailbox.

**Only one cycle at a time.** Each cycle holds a per-mailbox SQLite lease for its whole sync, classify, and label run (2 minutes, renewed every 20 seconds). The server, `watch`, and cron-driven `tag` runs can share a database safely; a second cycle exits with "busy". If a stalled process loses its lease to another one, it stops without writing anything further.

**Failures.** A message the model cannot classify is retried with backoff (1, 2, 4, … minutes, up to 6 hours) and gets `Needs Review` after 5 failures. A failed label write is retried the same way, up to 6 times. Authentication and permission errors stop the cycle immediately instead of failing message by message. A provider failure stops classification, but results classified earlier are still labeled.

**Shutdown.** On Ctrl-C or SIGTERM, the running cycle is cancelled (in-flight model and Gmail requests are aborted), nothing further is written, and the process exits within about 10 seconds.

**Logs** contain counts and status only, never subjects, senders, or bodies. Quiet repeats (idle cycles, the same setup problem) are logged once.

Example cron entry instead of `npm start` (set `POLL_INTERVAL_SECONDS=0` if a server shares the database):

```cron
*/5 * * * * cd /path/to/mail-triage && npm run --silent cli -- tag
```

Cron runs with a minimal `PATH`, so use the full path to `npm` if needed. On a Mac, a `launchd` agent can run `npm start` or `npm run cli -- watch` instead.

## Docker and self-hosted servers

```sh
cp .env.example .env    # set APP_PASSWORD, model, Gmail, and TAGGING_MODE
docker compose up -d --build
docker compose exec mail-triage node dist/node/cli/index.js status
```

- The container runs the setup page and background tagging in one process. Its health check uses `/api/health`.
- Inside the container the server listens on `0.0.0.0`, so it **refuses to start without `APP_PASSWORD`** (12+ characters). Compose publishes the port on the host's `127.0.0.1` only.
- `APP_PASSWORD` is also required whenever the app is reachable from anywhere but this machine: a non-loopback `PUBLIC_URL` (for example, a reverse proxy forwarding `https://mail.example.com` to `127.0.0.1`), or `TRUST_PROXY=true`.
- Data (SQLite with WAL) lives in the `mail-triage-data` volume at `/data`. Back it up, and back up the encryption key separately. To use a categories file, mount it (see `compose.yaml`) and set `CATEGORIES_FILE`.
- To connect Gmail on a remote server, put an HTTPS reverse proxy in front and set:

  ```sh
  PUBLIC_URL=https://mail.example.com   # must be https off loopback
  TRUST_PROXY=true
  # Google redirect URI: https://mail.example.com/api/gmail/oauth/callback
  ```

  The proxy must pass the original `Host` header; unknown hosts are rejected to block DNS rebinding. Example [Caddy](https://caddyserver.com/) site:

  ```caddyfile
  mail.example.com {
    reverse_proxy 127.0.0.1:8787
  }
  ```

  Alternatively, connect Gmail once through an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 server`) and open `http://localhost:8787`. After that, nothing needs the browser. `SETUP_PAGE=false` hides the page while keeping `/api/health`.

## Configuration reference

See [.env.example](.env.example) for every variable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TAGGING_MODE` | `dry-run` | `dry-run` never writes to Gmail; `apply` adds labels |
| `POLL_INTERVAL_SECONDS` | `120` | Server cycle interval (15–86400); `0` turns server polling off |
| `CONFIDENCE_THRESHOLD` | `0.7` | Below this, a message gets only `Needs Review` |
| `AUTO_LABEL_UNSCORED` | `false` | Label confidence-less answers too (always with `Needs Review`) |
| `CATEGORIES_FILE` | unset | JSON categories file, reloaded every cycle |
| `LABEL_PREFIX` | `Mail Triage` | Label namespace |
| `SYNC_MAX_MESSAGES` | `50` | Newest inbox messages listed per cycle (1–200) |
| `CLASSIFY_BATCH_SIZE` | `20` | Messages classified per cycle (1–100) |
| `TAG_BATCH_SIZE` | `50` | Messages labeled per cycle (1–200) |
| `MODEL_PROVIDER` | unset | `jev`, `openai`, or `openai-compatible` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Web application OAuth client |
| `MAIL_TRIAGE_ENCRYPTION_KEY` | unset | 32-byte key for refresh-token encryption |
| `GMAIL_LABEL_WRITES` | `false` | Request `gmail.modify`; required for apply |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Setup page bind address; non-loopback requires `APP_PASSWORD` |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Origin for CSRF checks, cookies, and the OAuth redirect |
| `APP_PASSWORD` | unset | Password for the setup page; required off loopback |
| `SETUP_PAGE` | `true` | Serve the setup page |

## Development

```sh
npm run dev        # server with tsx watch (setup page + background cycles)
npm run typecheck
npm test           # Vitest; no network: Google and model providers are faked
npm run build      # dist/node (server, CLI, setup page files)
```

Layout:

```
src/core          taxonomy, prompts, review reasons (no I/O)
src/providers     Jev, OpenAI Decisions, OpenAI-compatible, demo fixtures
src/server        config, SQLite store, Gmail OAuth/client/MIME, HTTP, setup page
src/server/services
                  categories file, sync, classify, labels (tagger), pipeline, scheduler
src/cli           CLI and single-email classifier
test              unit, contract, pipeline (fake Google), HTTP, and CLI tests
```

## Limitations

- The provider adapters follow the published request and response formats and are tested against recorded examples without network access. They have not been run against live Jev or OpenAI accounts in this repository. Availability, cost, latency, and accuracy depend on your account and your mail.
- The Gmail integration is tested against a simulated Google API, not a live mailbox. Start with dry-run on your own account before switching to apply.
- One user and one Gmail account. Only the newest inbox messages are considered; there is no history backfill and no push notifications (polling only).
- Labels are never removed. After changing categories or the threshold, older Mail Triage labels stay on messages until you remove them in Gmail. Renamed categories leave their old label in Gmail.
- Attachments are ignored; HTML mail is converted to text. Messages too large to download are classified from headers and Gmail's snippet.
- Stored mail copies are not pruned automatically; disconnecting Gmail deletes them.
- The OpenAI-compatible path needs JSON-schema structured output. If your server lacks it, set `OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS=false`; answers that do not match the schema are rejected.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 k3shav
