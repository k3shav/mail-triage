# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Do not open a public issue. Include steps to reproduce and the version or commit. Never include real email content or credentials.

## Scope and threat model

Mail Triage is a single-user background labeler that you run yourself. It holds a Gmail refresh token and copies of recent email, and it writes labels to Gmail without per-message confirmation. We treat the following as security bugs:

- reading tokens, settings, or mail-derived data without a valid session,
- cross-site request forgery, DNS rebinding, or another origin performing state changes on the setup page,
- any Gmail change other than creating labels under the configured prefix and adding them to messages,
- any Gmail write in dry-run mode, or in apply mode without `GMAIL_LABEL_WRITES=true` and a granted `gmail.modify`,
- labels written for a configuration, message, or classification that changed before the write, or by a process that no longer holds the mailbox lease,
- a confident category label on a refused, invalid, or low-confidence answer,
- tokens or secrets reaching the browser, logs, or the database unencrypted,
- email content (subjects, senders, bodies) appearing in logs, CLI output, status responses, or the setup page,
- email content changing model instructions or gaining capabilities beyond choosing an option.

Out of scope: attackers who already have shell access to the machine or can read the data directory, and the providers' own handling of data you choose to send them.

## How the design addresses these risks

| Area | Measure |
| --- | --- |
| Binding | Loopback by default. The server refuses non-loopback binds without `APP_PASSWORD` and requires an https `PUBLIC_URL` off loopback. `SETUP_PAGE=false` serves no page at all. |
| Sessions | Random session IDs, stored only as hashes. Cookies are `HttpOnly` and `SameSite=Lax` (Lax is needed for the OAuth return), and `__Host-` + `Secure` over https. |
| Requests | Host header allowlist; same-origin `Origin` check plus a per-session CSRF header on every state change; 64 KB JSON body limit; Zod validation. Only `/api/health` is public. |
| Sign-in | Password compared in constant time; sign-in attempts rate-limited per client. |
| OAuth | Web-application client with an exact redirect URI. State is 32 random bytes, stored hashed, single-use, expires in 10 minutes, and is tied to the browser session. Callback errors redirect with fixed codes only. |
| Tokens | Refresh token encrypted with AES-256-GCM, with the account ID as associated data. Access tokens live only in memory. Granted scopes are recorded; apply mode requires `gmail.modify` and reports its absence. |
| Gmail writes | The client can only create labels and call `messages.modify` with `addLabelIds`. Each cycle holds a renewable, owner-checked SQLite lease. The tagger re-reads the message and checks its thread; then the Gmail client runs a per-message guard immediately before dispatching every write attempt (after any token refresh and before each retry) that re-checks lease ownership, account, message, categories revision, and classification in one transaction. A failed guard sends nothing and is not retried. Auth and permission errors stop the cycle. |
| Review | Refused, invalid, and low-confidence answers get only `<prefix>/Needs Review`. Confidence-less answers are labeled only on explicit opt-in and always with Needs Review; no confidence or acceptance is fabricated. |
| Mail content | Stored as plain text in SQLite; HTML is converted to text; attachments are skipped. Size, part-count, and nesting limits apply. Nothing outside the database carries message content. |
| Models | Email text is sent as data with an untrusted-content notice; answers are restricted to the configured options; no tools. With Jev or OpenAI, classified mail is sent to that provider. |
| Browser | The setup page shows status and categories only. Strict CSP (`script-src 'self'`, `style-src 'self'`, no inline code, `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, `nosniff`, and `no-store` on API responses. |

## Operational advice

- Keep `MAIL_TRIAGE_ENCRYPTION_KEY` outside the data volume and back it up separately.
- Run in dry-run first, and switch to apply only after the counts and a sample of labels look right.
- Put a TLS reverse proxy in front of any server that is not on loopback, and set `PUBLIC_URL` and `TRUST_PROXY=true`, or connect Gmail once through an SSH tunnel and set `SETUP_PAGE=false`.
- Restrict file permissions on the data directory; it contains email text.
