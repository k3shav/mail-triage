# Research and implementation decisions

Checked 16 November 2026 against primary project and API documentation.

## Existing projects

This idea already exists in several forms. A new classifier should not claim to be the first.

| Project | Documented scope | Implication for this project |
| --- | --- | --- |
| [Jev Mail Classifier](https://github.com/parth-kp/jev-mail-classifier) | Jev-based inbox classification and config-driven mailbox actions | Closest existing project; users happy with that workflow should evaluate it first. |
| [Inbox Zero](https://github.com/elie222/inbox-zero) | Open-source email client and AI assistant, Gmail/Outlook, plain-language rules, self-hosting | A broader existing option. Mail Triage targets a focused single-user classifier with fewer services. |

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
- Review: uncertain, refused, or invalid predictions require review. Human corrections remain distinct from model predictions.

Configuration revisions must be attached to classifications. Editing a definition must not silently authorize applying a stale result. Do not pretend a keyword demo classifies arbitrary mail with AI.

## Gmail and deployment boundaries

The user selected Gmail OAuth as the first connector. [Google's web-server OAuth guidance](https://developers.google.com/identity/protocols/oauth2/web-server) describes offline refresh, exact redirect URIs, and state validation. Use expiring single-use state tied to the initiating session, and keep credentials server-side with refresh tokens encrypted at rest.

[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) distinguish reading messages from editing labels. Applying labels to a message uses [`users.messages.modify`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify), which needs `gmail.modify` (or another documented applicable scope). That grant is broader than the app's intended additive-label operation. Document it honestly. Public distribution can require Google verification; users running their own OAuth project must follow Google's testing/consent rules.

The intended operation is an explicit preview followed by per-message application of namespaced labels using `addLabelIds` only. It does not change unread state, remove labels, archive, delete, or send. Never classify or modify the developer's own mailbox during automated verification.

Mac and server runs share one runtime and persistent storage. Loopback is the local default; a remotely reachable server requires authentication and HTTPS termination. Email bodies are private local data; ignore database files and credentials in Git. Render plain text, with no remote image loading or email HTML execution.
