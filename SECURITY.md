# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Do not open a public issue. Include steps to reproduce and the version or commit. Never include real email content or credentials.

## Scope and threat model

Mail Triage is a single-user app that you run yourself. It holds a Gmail refresh token and copies of recent email, so we treat the following as security bugs:

- reading mail, tokens, or settings without a valid session,
- cross-site request forgery, DNS rebinding, or another origin performing state changes,
- any Gmail change other than adding Mail Triage labels to one previewed message after explicit confirmation,
- applying labels from a stale or mismatched preview (wrong account, message, configuration revision, decision revision, or provider/model),
- tokens or secrets reaching the browser, logs, or the database unencrypted,
- email content being executed or rendered as HTML, or loading remote content,
- email content changing instructions or gaining capabilities beyond choosing an option.

Out of scope: attackers who already have shell access to the machine or can read the data directory, and the providers' own handling of data you choose to send them.

## How the design addresses these risks

| Area | Measure |
| --- | --- |
| Binding | Loopback by default. The server refuses non-loopback binds without `APP_PASSWORD` and requires an https `PUBLIC_URL` off loopback. |
| Sessions | Random session IDs, stored only as hashes. Cookies are `HttpOnly` and `SameSite=Lax` (Lax is needed for the OAuth return), and `__Host-` + `Secure` over https. |
| Requests | Host header allowlist; same-origin `Origin` check plus a per-session CSRF header on every state change; 64 KB JSON body limit; Zod validation. |
| Sign-in | Password compared in constant time; sign-in attempts rate-limited per client. |
| OAuth | Web-application client with an exact redirect URI. State is 32 random bytes, stored hashed, single-use, expires in 10 minutes, and is tied to the browser session. Callback errors redirect with fixed codes only. |
| Tokens | Refresh token encrypted with AES-256-GCM, with the account ID as associated data. Access tokens live only in memory. Granted scopes are recorded; applying labels requires `gmail.modify`. |
| Gmail writes | The client can only create labels and call `messages.modify` with `addLabelIds`. Each apply is tied to a preview, re-checked, claimed atomically, and idempotent on replay. |
| Mail content | Bodies are stored and shown as plain text; HTML is stripped to text; attachments are skipped. Size, part-count, and nesting limits apply. |
| Models | Email text is sent as data with an untrusted-content notice; answers are restricted to the configured options; no tools. |
| Browser | Strict CSP (`script-src 'self'`, no inline styles or scripts, `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, `nosniff`, and `no-store` on API responses. |

## Operational advice

- Keep `MAIL_TRIAGE_ENCRYPTION_KEY` outside the data volume and back it up separately.
- Start with `GMAIL_LABEL_WRITES=false` and turn it on only after you trust the classifications.
- Put a TLS reverse proxy in front of any server that is not on loopback, and set `PUBLIC_URL` and `TRUST_PROXY=true`.
- Restrict file permissions on the data directory; it contains email text.
