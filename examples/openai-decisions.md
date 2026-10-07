# OpenAI Decisions and image evidence

The server can run its twelve judgment tools through the native [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions). Select it explicitly:

```bash
export JEV_PROVIDER=openai
export OPENAI_API_KEY=your-openai-key
npx -y @jkudish/jev-mcp
```

The default model is `gpt-6-luna`, the model currently documented for the beta endpoint. `JEV_MCP_MODEL` overrides it. This calls `POST https://api.openai.com/v1/decisions`; it is a different model and contract from Jev's System One API and OpenRouter's Jev Decisions endpoint. OpenAI is opt-in; an `OPENAI_API_KEY` alone does not participate in auto-selection.

`jev_decide` accepts optional `images`, each `{id, data_url}`, alongside its required `decision`, `evidence`, `priorities`, and `candidates`. Text and all images are shared evidence for the recommendation and independent requirement checks in one request. The server labels each image with its id, and returns `image_evidence` metadata (id, media type, bytes, SHA-256) without returning base64. These hashes identify the submitted bytes; retaining the original evidence is the caller's responsibility.

Only inline base64 PNG, JPEG, WebP, and GIF data URLs are accepted. Hosted URLs and file ids are unsupported by the endpoint. This server limits calls to eight images, four MiB per image, and eight MiB in total; these are local bounds, not advertised OpenAI API limits. Images cannot be truncated, silently dropped, or sent through a text-only provider. Other tools retain their text-only arguments; audio and video need text preprocessing.

From a source checkout, inspect the sample without a key or API call:

```bash
npm ci
node examples/openai-decide.mjs examples/openai-decide-sample.json --dry-run
```

The sample is a synthetic one-pixel image and explicitly provides no product evidence. Replace it with a real inline image and corresponding decision, or run the placeholder to exercise the insufficient-evidence path:

```bash
export OPENAI_API_KEY=your-openai-key
node examples/openai-decide.mjs examples/openai-decide-sample.json
```

Every `jev_decide` result includes `recommendation.reason`. For a mocked recommendation with a contradicted requirement, it reads:

```text
Recommended release (probability 0.95). Requirement checks: 1=contradicted.
```

With `escalate_on_contradiction: true`, the same answer is withdrawn and the reason explains the escalation. Escape hatches and malformed recommendations also have reasons. The text is derived from the returned choice, probability, and per-requirement checks; it does not claim to reveal model reasoning or describe unseen image details. The [official guide](https://developers.openai.com/api/docs/guides/decisions) directs applications needing a written explanation to Responses with Structured Outputs. A caller can generate such an explanation separately from the evidence and typed results; this server does not add a second paid call.

OpenAI's probability and confidence fields retain their native values. They are not asserted to have TypeSafe's calibration or confidence semantics. Validate each tool's thresholds against labelled examples before using this provider for automatic actions. Refusals, missing answers, wrong types, duplicate answer names, and malformed distributions follow the tools' existing `invalid_response` behavior, and valid sibling judgments remain available.

`JEV_OPENAI_BASE_URL` overrides the API root (default `https://api.openai.com/v1`); `/decisions` is appended and a trailing slash is accepted. Requests use the same whole-request deadline, retry policy, cancellation, and response-size ceiling as the existing fetch transports. Errors expose fixed diagnostics and HTTP status codes, never upstream text.

`npm test` exercises this path against a local HTTP stand-in. With `OPENAI_API_KEY` set, `npm run test:e2e` also runs the native text-and-image smoke. Without the key, it skips that live check.
