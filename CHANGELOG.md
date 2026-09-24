# Changelog

## 0.8.0

- New `jev_noul` tool: batched calibrated probability for stated propositions, labeled likely / unlikely / uncertain. Prompted by [#31](https://github.com/jkudish/jev-mcp/issues/31).

## 0.7.0

- Use `@jkudish/jev-agent-tools` for built-in provider selection and direct TypeSafe/Vercel judgments; retain MCP-specific retry and compatible endpoint handling.
- Node.js 22 or newer is required (was 20); the shared wire package declares it.
- Docs: provider setup notes and a pointer to the shared package's add-a-provider guide.

## 0.6.0

- Transport resilience: bounded retries on 408, 429, and 5xx only; ambiguous network failures never retry, so a paid call cannot double-process. Adds a request deadline, a 1 MB body ceiling, and cancellation wiring. Via [#23](https://github.com/jkudish/jev-mcp/issues/23) by oppih.
- The typesafe transport routes its SDK through standalone undici to avoid an SDK process-crash bug on cancellation ([typesafe-sdk-js#2](https://github.com/typesafe-ai/typesafe-sdk-js/issues/2)), with a regression test.
- `jev_review` and `jev_gate` now validate score distributions and explain their decision with `reason_codes` and `limiting_rubrics`; a malformed distribution marks the rubric `invalid_response`. Via [#20](https://github.com/jkudish/jev-mcp/pull/20) by deadczarvc.
- Strict tool inputs: all ten tools reject unknown arguments and nested keys; a typo is a client error, not a silently missing argument. Via [#19](https://github.com/jkudish/jev-mcp/pull/19) by deadczarvc.
- Every tool fails closed on a null or non-object answers envelope instead of crashing; each reports its structured `invalid_response` results.
- `jev_verify`, `jev_screen`, and `jev_find` fail closed on malformed answers: verify marks claims `invalid_response`, screen recommends `review`, find refuses to rank. Via [#8](https://github.com/jkudish/jev-mcp/pull/8) by oppih.
- Choice answers are validated by one shared contract across tools; `jev_classify` reports a non-finite confidence as `null` instead of passing it through.
- `jev_extract` uses the shared float-safe sum tolerance, so a 0.33 / 0.33 / 0.33 distribution is accepted like everywhere else.
- Jev-compatible endpoints: `JEV_API_KEY` plus `JEV_API_BASE_URL` runs judgments through any System One-compatible service; error bodies are redacted so the endpoint cannot echo your key. Via [#6](https://github.com/jkudish/jev-mcp/pull/6) by Garfielk.

## 0.5.0

- New `jev_review`: score a diff against the request on four rubrics plus safe-to-apply, returning one `auto | review | escalate` action with thresholds you control. Adapted from [burnigtm/jev-mcp](https://github.com/burnigtm/jev-mcp), via [#2](https://github.com/jkudish/jev-mcp/pull/2) by rimusz.
- New `jev_gate`: the completion gate. The same patch review plus up to 16 completion claims checked against caller-supplied evidence in one request, with `reason_codes` for the final action.
- Deliberately excluded: the upstream PR's `jev_coding_loop` agent loop. This package stays judgment primitives that a coding agent calls.
- New `jev_rerank`: one independent relevance probability per candidate in a single request, sorted, ids preserved. Bounded at 250 candidates and a 100,000-character budget.
- New `jev_compare`: same_fact / contradicts / different_facts between two passages, plus optional per-aspect judgments, each with distributions and an auto-versus-review decision.
- New `jev_extract`: your regex finds candidate substrings, Jev picks each field's value, and values return verbatim. Regexes run in a sandboxed worker; zero-match fields skip the model entirely.
- Docs: README restructured around the ten tools, with when-to-call-which guidance and a live-captured `jev_rerank` example.

## 0.4.0

- New `jev_classify`: assign up to 64 items to a shared catalog of up to 250 classes in one batched request. Per-item distribution, confidence, margin, and an auto-versus-review decision; malformed answers surface as `invalid_response`, never uncertainty.

## 0.3.0

- Cloudflare Workers AI support: with `CLOUDFLARE_API_TOKEN` (or `JEV_CLOUDFLARE_API_TOKEN`) and `CLOUDFLARE_ACCOUNT_ID` set, judgments run through Cloudflare at the `typesafe/jev` alias; `JEV_PROVIDER=cloudflare` forces it.
- Vercel AI Gateway support: with `AI_GATEWAY_API_KEY` set, judgments run through the AI SDK evaluate API at `typesafe-ai/jev`; `JEV_PROVIDER=vercel` forces it.
- Provider resolution order: TypeSafe direct, OpenRouter, Cloudflare, Vercel.

## 0.2.0

- OpenRouter support: with only an `OPENROUTER_API_KEY`, all judgments route through OpenRouter's Decisions API (alpha) at the same pricing; `JEV_PROVIDER` forces `typesafe` or `openrouter`.
- Results now report the transport used (`provider`, resolved `model`).

## 0.1.0

Initial release, published to npm as `@jkudish/jev-mcp` (the unscoped `jev-mcp` name belongs to another project).

- `jev_verify`: claims versus evidence with supports / contradicts / says_nothing distributions, confidence, and an auto-versus-review gate.
- `jev_screen`: injection, substance, and relevance probabilities with an advisory pass / review / block / skip recommendation.
- `jev_find`: semantic ranking of up to 250 candidates plus an existence check, no embeddings.
- Token usage and estimated cost on every result.

No versioning policy has been declared yet; treat 0.x APIs as unstable.
