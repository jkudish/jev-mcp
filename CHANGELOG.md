# Changelog

## 1.0.0 (unreleased)

jev-mcp is now **discern-mcp**: `@jkudish/discern-mcp`, bin `discern-mcp`. "Jev" names TypeSafe's model, and the server now also runs on OpenAI's Decisions API, so the package takes a provider-neutral name. Everything that worked in 0.14 keeps working through 1.x; the old names are removed in 2.0. See [Migrating from jev-mcp](README.md#migrating-from-jev-mcp).

- Breaking: the package is `@jkudish/discern-mcp` and the bin is `discern-mcp`. MCP `serverInfo.name` and stderr log lines say `discern-mcp`.
- Tools are listed as `discern_*` (`discern_verify`, `discern_gate`, …). The matching `jev_*` names stay callable as hidden aliases. `DISCERN_TOOL_NAMES=jev` lists the `jev_*` names instead, with `discern_*` still callable; any other value fails at startup. Each result's `tool` field echoes the name that was called.
- Environment variables are `DISCERN_*` (`DISCERN_PROVIDER`, `DISCERN_MCP_MODEL`, `DISCERN_MCP_AUTH_TOKEN`, …). Every `JEV_<X>` still works as an alias of `DISCERN_<X>` and prints one stderr deprecation line at startup. Setting both to different values fails at startup with an error that names both variables and never their values. An empty `DISCERN_MCP_MODEL` now means the default model.
- Compatibility package: `@jkudish/jev-mcp` 1.0.0 depends on `@jkudish/discern-mcp` and runs it with `DISCERN_TOOL_NAMES=jev`, so existing `npx @jkudish/jev-mcp` configs and permission allowlists keep working. It also re-exports the `./server` library entry.
- Cloudflare Clef models: `DISCERN_PROVIDER=cloudflare` with `DISCERN_MCP_MODEL=clef` or `clef-flash` runs Cloudflare's Clef decision models through the existing Cloudflare transport and its retry and deadline rules.
- OpenAI Decisions provider: `DISCERN_PROVIDER=openai` with `DISCERN_OPENAI_API_KEY` or `OPENAI_API_KEY`, via the shared `@jkudish/discern-agent-tools` transport. Never auto-detected. Refusals invalidate only the refused judgment.
- Library: `createServer({ toolNames })` and `resolveToolNames()` are exported from `./server`; the bin entry is exported as `./bin`. Shared provider code moves to `@jkudish/discern-agent-tools` 1.0.0.
- Startup configuration errors (env conflicts, invalid `DISCERN_TOOL_NAMES`) print one `[discern-mcp]` line on stderr and exit 1. stdout stays reserved for MCP.
- Tool descriptions no longer attribute every judgment to Jev; the configured provider answers.
- The skill moves from `skills/jev` to `skills/discern`.

## 0.14.1

- OpenRouter: token-limit rejections report `OpenRouter decisions API 400 (max_tokens_exceeded)`; unknown error types and all upstream text stay hidden. Via [#57](https://github.com/jkudish/jev-mcp/pull/57) by [@nicolas-found42](https://github.com/nicolas-found42).

## 0.14.0

- OpenRouter: `jev-latest` uses `~typesafe/jev-latest`, an explicit alias is no longer double-prefixed, and results report the returned snapshot. Explicit pins are unchanged. Reported in [#55](https://github.com/jkudish/jev-mcp/issues/55).
- Vercel: opt-in Gateway zero-data-retention routing with `JEV_VERCEL_ZERO_DATA_RETENTION=1`, via `@jkudish/jev-agent-tools` 0.2.0 ([jev-agent-tools#7](https://github.com/jkudish/jev-agent-tools/pull/7)). Docs via [#56](https://github.com/jkudish/jev-mcp/pull/56) by [@lloydsilvertwo](https://github.com/lloydsilvertwo).
- Dependency updates: MCP SDK 2.3.1.

## 0.13.0

- `jev_verify`: contradictions now require evidence about the claim's own subject. Off-subject contradictions become `unsupported` and require review; missing subject judgments also require review. Via [#54](https://github.com/jkudish/jev-mcp/pull/54) by [@deadczarvc](https://github.com/deadczarvc), prompted by [#53](https://github.com/jkudish/jev-mcp/issues/53).
- Runnable deny-only coding-agent hook example, with optional human escalation and bounded input, runtime, and subprocess cleanup. Via [#52](https://github.com/jkudish/jev-mcp/pull/52) by [@Rex-Gao](https://github.com/Rex-Gao), prompted by [#51](https://github.com/jkudish/jev-mcp/issues/51).

## 0.12.0

- Side-effect-free imports: the package root and `/server` export `createServer()` without starting a transport; the CLI stays unchanged. The new exports map replaces `dist/*` deep imports. Requested in [#49](https://github.com/jkudish/jev-mcp/issues/49) by [@deadczarvc](https://github.com/deadczarvc).
- Opt-in `/mcp/<token>` authentication for HTTP clients that cannot send bearer headers, with URL-safe token validation and token stripping after authentication. Via [#50](https://github.com/jkudish/jev-mcp/pull/50).
- TypeSafe requests retry transient HTTP failures, honor bounded `Retry-After`, and report the effective model through `jev-agent-tools` 0.1.4; exhausted rate limits and server failures remain tool errors rather than invalid judgments. Reported in [jev-agent-tools#5](https://github.com/jkudish/jev-agent-tools/issues/5) by [@deadczarvc](https://github.com/deadczarvc).

## 0.11.0

- New `jev_audit` tool: a max-gated failure-mode battery (hallucinated, off-target, incomplete, wrong format) plus an omission check, auditing extracted values against their source before they're trusted. Via [#48](https://github.com/jkudish/jev-mcp/pull/48) by Rex-Gao, prompted by [#45](https://github.com/jkudish/jev-mcp/issues/45).
- `jev_decide`: names `contradicted_requirements` on the recommendation, and opt-in `escalate_on_contradiction` withdraws a contradicted pick in addition to the warning; no silent re-selection. Via [#46](https://github.com/jkudish/jev-mcp/pull/46) by Rex-Gao, prompted by [#43](https://github.com/jkudish/jev-mcp/issues/43); the structural-field idea from [#44](https://github.com/jkudish/jev-mcp/pull/44) by xujiantop-crypto.
- `jev_review` / `jev_gate`: optional per-file review mode — one request, composed auto/mean/min/limiting, combined request+tests+diffs budget, per-file truncation. Via [#47](https://github.com/jkudish/jev-mcp/pull/47) by Rex-Gao, prompted by [#42](https://github.com/jkudish/jev-mcp/issues/42).
- Docs: runnable Exa search → classification example. Via [#41](https://github.com/jkudish/jev-mcp/pull/41) by RogueTex.

## 0.10.1

- `--http` advertises a static tool list and refuses `subscriptions/listen` in-band: previously a client that opened a listener parked an idle stream on a concurrency slot for its lifetime, and enough listeners could starve the server of slots. Slot accounting no longer leaks on a rejected handler either.
- Docs: the HTTP section names the transport env var and the static tool list.

## 0.10.0

- Opt-in stateless Streamable HTTP: `jev-mcp --http` (or `JEV_MCP_TRANSPORT=http`) serves MCP 2026-07-28 per request and 2025-era clients through the SDK's stateless fallback, with no sessions, on `PORT` (default 8080) at `/mcp`, with `/health`. `HOST` defaults to loopback; binding beyond it is explicit. `JEV_MCP_AUTH_TOKEN` gates it with a bearer token and is required unless `HOST` is loopback; Host/Origin rebinding guards answer fixed-string 403s. Concurrent requests are capped at `JEV_MCP_MAX_CONCURRENCY` (default 16) with `429` backpressure, and a cancelled request aborts its in-flight regex worker and Jev calls. Stdio stays the default. Via [#37](https://github.com/jkudish/jev-mcp/pull/37) by shivasymbl.
- Stdio now also answers 2026-07-28 clients; 2025-era clients see no change.
- Client-visible provider errors are fixed strings (provider name and status only); upstream response text, including reflected credentials, never reaches tool error content.
- `jev_classify` keeps label ids collision-free and tallies on a null prototype, so labels like `constructor` or `__proto__` can no longer shadow `Object.prototype` or collide with generated ids. Via [#36](https://github.com/jkudish/jev-mcp/pull/36) by kittimzhe.
- `jev_verify` no longer mistakes an evidence item literally named `none` for its internal no-source option; the internal key now skips occupied `none_N` ids. Via [#38](https://github.com/jkudish/jev-mcp/pull/38) by xujiantop-crypto.
- Internal: `@modelcontextprotocol/sdk` 1.x replaced by the v2 packages `@modelcontextprotocol/server` and `@modelcontextprotocol/node` 2.1.0; tools are registered once and replayed onto a fresh server per connection or request.

## 0.9.0

- Ships an agent skill inside the package: `skills/jev/` is included in the npm tarball, so coding agents get judgment-tool policy — which tool to call when, fail-closed handling, privacy — without hand-written prompts. Prompted by [#34](https://github.com/jkudish/jev-mcp/issues/34) by panaalexandrucristian.
- `jev_extract` keeps multi-letter regex flags (`gi`) intact instead of mangling them into `gig` and throwing. Found in [#34](https://github.com/jkudish/jev-mcp/issues/34).
- Internal: zod 4 and TypeScript 7; no tool behavior changes. `tools/list` input schemas gain a `propertyNames` field from zod 4's JSON Schema conversion. Via [#35](https://github.com/jkudish/jev-mcp/pull/35).
- Dependency updates: `@jkudish/jev-agent-tools` 0.1.2 and `@modelcontextprotocol/sdk` 1.30.1.

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
