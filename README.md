# Mail Triage

An open-source, Gmail-first email classifier for your Mac or a self-hosted server. Custom categories, separate action decisions, and explicit review before mailbox labels change.

Implementation is in progress on a stack of pull requests. This branch contains the classifier core: taxonomy, review policy, and model adapters.

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
