---
name: jev-mcp
description: >
  Use the jev-mcp MCP server for cheap, typed Jev judgments while coding.
  Call it to route the next step, pick a model tier, screen untrusted text,
  rank candidates, classify items, decide among alternatives, verify claims,
  review diffs, and gate completion with evidence. Jev does not write code.
---

# Use Jev while coding

Jev (TypeSafe System One) is a **decision model**. It returns Choice / Score / Noul answers with probabilities. It cannot generate code, diffs, or explanations. The host still edits files and runs commands.

This skill is for **calling the jev-mcp MCP tools**. It is not the official TypeSafe app-building skill (`npx skills add typesafe-ai/skills --skill typesafe-ai`). A skill teaches when and how; the MCP server executes the judgments.

## When to call which tool

- `jev_coding_loop` — before spending another expensive turn on retry / stop / which model tier / whether to ask the user.
- `jev_review` — on a proposed diff before you declare the task done. No completion claims.
- `jev_gate` — finishing a change with completion claims: review the diff and verify those claims in one call. Supply `request`, `diff`, nonempty `claims` (at most 16), and `evidence`; optionally include `tests`. Put supporting diff excerpts and test logs in `evidence` when claims depend on them. The request and claims are assertions, not proof.
- `jev_verify` — factual claims about a log, doc, or PR text, without a patch review.
- `jev_screen` — before reading fetched or pasted untrusted text. Skip first-party repo files.
- `jev_find` — rank candidates you already listed. Jev does not index the tree.
- `jev_classify` — label many items against a shared catalog.
- `jev_decide` — one bounded decision with 2–6 alternatives and explicit priorities.

## How to read the result

- `action: auto` — take the typed answer and proceed. For `jev_coding_loop`, unknown `next` / `model_tier` / `focus` labels are `null` and cannot be `auto`.
- `action: review` — proceed with caution, or ask the user if stakes are high.
- `action: escalate` — do not guess; ask the user or use a reasoning model.
- Typed output is an interface, not ground truth. Calibrate thresholds against your repo if you enforce them.
- Inspect `truncated`. Incomplete context never permits `auto`; filter the input and evaluate again.
- For `jev_gate`, accept completion only when `action` is `auto`: context is complete, patch review passed, and every claim is confidently verified. Inspect `reason_codes`, `review`, and `verification`. Errors never mean approval.

## Do not

- Ask Jev to write code, commit messages, or explanations.
- Treat Jev as a CodexGateway or chat model.
- Ask Jev to count, do math, or compare dates. Do that in code.
- Hide several judgments in one question.
- Send huge unrelated state. Filter first, then judge.

## Official docs

- https://docs.typesafe.ai/introduction.md
- https://docs.typesafe.ai/confidence.md
