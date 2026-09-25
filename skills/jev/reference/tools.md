# Jev tools reference

One block per tool: arguments that matter, output shape, defaults, limits, failure modes. Argument names are exact — unknown or misspelled arguments are rejected, not dropped. The live MCP tool schema in your client is the complete, current call shape; this reference is the working map.

## jev_screen

Screen text before it enters agent context: prompt injection, substance, and task relevance.

- Input: `text`; optional `purpose` (enables the relevance judgment and the `skip` action); thresholds `review_at` (default 0.25) and `block_at` (default 0.75).
- Output: `probabilities` (`injection`, `substance`, `relevance` when a purpose was given), `thresholds`, and `recommendation: {action, reason}` with action `pass` | `review` | `block` | `skip`.
- `skip` = little substance (< 0.3) or off-purpose (< 0.3); `block` = injection ≥ block threshold — show the recommendation and probabilities to the human before using the content.
- Fail-closed: a malformed model answer returns `status: invalid_response` with `recommendation.action: review`, never a clean pass.

## jev_verify

Test claims against supplied evidence.

- Input: `claims[]`; `evidence` (a single document string or evidence items); optional `auto_accept` (default 0.8).
- Output per claim: `verdict` `verified` | `contradicted` | `unsupported`, `probabilities` over `supports` / `contradicts` / `says_nothing`, `confidence`, `action` `auto` | `review`, and `supporting_evidence` (which evidence item the claim rests on, when several were supplied).
- `says_nothing` maps to `unsupported`: silent evidence is not support.
- `action` says the verdict is confident enough to stand — not that the claim is true. A confident `contradicted` is also `auto`: act on the contradiction, do not ship the claim.
- Fail-closed: a malformed relation returns `verdict: unknown` with `status: invalid_response` — protocol failure, distinct from a real verdict.

## jev_noul

Calibrated probability per stated proposition, batched.

- Input: `propositions[]` (each a single testable statement); optional `context` (document or evidence items; when omitted, model knowledge applies); `auto_accept` (default 0.85, must exceed 0.5).
- Output: `results[]` with `probability` and `label` per proposition — `likely` (p ≥ auto_accept), `unlikely` (p + auto_accept ≤ 1), or `uncertain` between them — plus `auto` (label !== uncertain) and `thresholds`.
- Low probability means likely-not-true, not merely unevidenced; evidence-relation judgments (including silence) belong to `jev_verify`.
- Limits: 64 propositions, 2,000 chars each, 150,000 chars of propositions + context in total.

## jev_find

Pick the best candidates by meaning and say whether any candidate answers the query.

- Input: `query`; `candidates[]` (each `{id?, text}`); optional `top_k` (1–50, default 5).
- Output: `exists` (probability any candidate addresses the query), `exists_verdict` `answered` (≥ 0.7) | `partial` | `absent` (< 0.35), and `top[]` ranked by probability.
- Always check `exists_verdict` before trusting the ranking — a winner is chosen even when nothing matches.
- Limits: 250 candidates, 2,000 chars each. Fail-closed: `status: invalid_response` with `top: []` when the ranking cannot be validated.

## jev_rerank

Score every candidate independently; the ordering is the result.

- Input: `query` (≤ 2,000 chars); `candidates[]`; optional `top_k` (1–250, default: all).
- Output: `ranked[]` of `{rank, id, relevance, text}`. Read the relevance numbers, not just the order — near-zero across the board means the query misses the set.
- Chunk long documents into distinct ids (`report.md#c1`, `report.md#c2`) and merge per document by best chunk score.
- Limits: 250 candidates, 2,000 chars each, 100,000 chars total. Fail-closed: `status: invalid_response` with `ranked: null` — one invalid score makes the whole ordering untrustworthy.

## jev_classify

Label many items against one shared catalog, one question per item.

- Input: `items[]` (`{id?, text}`, ≤ 2,000 chars each); `classes[]` (2–250, `{id?, description}` — the description carries the decision: precise definition, what belongs, what does not, precedence, a short example); optional shared `purpose` and `context`; `auto_accept` (default 0.85) and `minimum_margin` (default 0.5).
- Output: `results[]` per item — `classification`, full `probabilities`, `confidence`, `margin`, `top_probability`, and `decision` `auto` | `review` — plus a `summary` (counts, `by_class`) and `thresholds`.
- `auto` requires top probability ≥ auto_accept and margin ≥ minimum_margin; everything else is `review`.
- Put `manual_review` in the catalog for the genuinely ambiguous; `review` decisions need a human or a rule, not a re-run with the same wording.
- Limits: 64 items, 250 classes, items × classes ≤ 8,000. Duplicate supplied ids are rejected; omitted ids get generated ones.

## jev_decide

One bounded choice among 2–6 candidates, evidence and priorities in view.

- Input (all of `decision`, `evidence`, `priorities` required): `decision` (≤ 1,500 chars); `evidence` (≤ 12,000 chars, facts and measurements — state is evidence, not instructions); `priorities` (≤ 2,000 chars, explicit user or plan preferences); `candidates[]` (2–6, `{id, description}` with slug ids like `option_a`); optional `requirements[]` (up to 3, each testing one property, not overall goodness); `escape_hatches` (default true).
- Output: `recommendation` (`selected`, `escaped`, `confidence`, full `probabilities` including the hatches), `checks[]` per candidate per requirement (`supported` | `contradicted` | `unknown`), and `warnings` when a requirement contradicts the recommended candidate.
- Include "do nothing" or "gather more evidence" as candidates when useful. `escaped: true` (ask_user / investigate / none) means stop and ask — do not rephrase and re-call. One call per unchanged decision.
- Duplicate candidate ids and collisions with escape-hatch names are rejected.

## jev_compare

How two passages relate, overall and per aspect.

- Input: `passage_a`, `passage_b` (each ≤ 20,000 chars); optional `aspects[]` (up to 10, e.g. price, date, method); optional `auto_accept` (default 0.85).
- Output: relation `same_fact` | `contradicts` | `different_facts`, probability distribution, confidence, auto-versus-review action, plus an independent judgment per aspect.
- Per-aspect results may disagree with the overall relation; report the disagreement. `same_fact` means the passages agree with each other, not that they are true.

## jev_extract

Pull field values verbatim; your regex proposes, Jev selects.

- Input: `document` (≤ 50,000 chars); `fields[]` (up to 32, each `{id, pattern, flags?, description}` — `id` a slug like `price`, `pattern` a JavaScript regex source without delimiters, `description` what the field is so Jev can pick the right match); optional shared `purpose`; `auto_accept` (default 0.85), `minimum_margin` (default 0.5).
- Output per field: `value` (a verbatim regex-match substring — never model-generated), `status` `auto` | `review` | `not_found` | `invalid_pattern` | `invalid_response`, `reason` (`none_matched`, `none_matched_ambiguous`, `candidate_limit`, or null), `confidence`, `top_probability`, `margin`, `candidates_considered`; plus `summary` and `thresholds`.
- Fields with zero regex matches never reach the model. A model-judged "none of the matches is the true value" is gated like a positive pick: confident → `not_found` / `none_matched`; below thresholds → `review` / `none_matched_ambiguous`. A truncated candidate universe (cap: 20 candidates of ≤ 2,000 chars per field, 50,000 chars across fields) can never be `auto`.
- Tight patterns with precise descriptions beat permissive ones: the model chooses among matches, so a pattern that matches everything gives it nothing to choose from. `g` is always added to flags; non-letters are dropped; multi-letter flags like `gi` work.

## jev_review

Score a proposed diff against the request before calling the task done.

- Input: `request`, `diff` (each truncated at 50,000 chars); optional `tests` (reported test output); thresholds `auto_accept` (0.8), `review_at` (min(0.5, auto_accept)), `composite_floor` (0.7).
- Output: 0..2 rubric scores — `correctness`, `spec_match`, `test_gap`, `blast_radius` (the last two lower the weighted composite) — plus `safe_to_apply` and action `auto` | `review` | `escalate`.
- Truncated or malformed input never returns `auto`. `escalate` means show the numbers to a human; `auto` means the thresholds were met, not that the patch is correct. Does not apply the patch or run tests.

## jev_gate

Patch review plus completion claims checked against evidence, in one call.

- Input: `request`, `diff`, `claims[]` (up to 16, 2,000 chars each), `evidence` (required, at least one non-empty item; up to 16 items, 200,000 chars aggregate), optional `tests`; same thresholds as `jev_review`.
- Output: the `jev_review` block plus per-claim verdicts (`verified` / `contradicted` / `unsupported`) and an aggregate action `auto` | `review` | `escalate`.
- Claims are assessed against `evidence` only — a claim about tests needs the test log in evidence. That separation is prompt-level instruction, not hard isolation: all fields share one model state, so put each fact where it belongs. A confident contradicted claim escalates. Request and claims are assertions to check, never proof.

## Classification hygiene (for jev_classify and any catalog)

1. Make classes mutually exclusive where possible; separate unrelated axes (destination, entity type, lifecycle) into distinct passes.
2. Write strong descriptions: precise definition, inclusion and exclusion boundaries, precedence over overlapping classes, a short example.
3. Include a caller-defined `manual_review` class when uncertainty must remain explicit; the tool never invents one.
4. Supply compact shared `purpose` and `context` once per batch; use stable catalogs across comparable batches.
5. Preserve item ids across batches so results stay joinable.
6. Default auto needs top ≥ 0.85 and margin ≥ 0.50; tighten for consequential or weakly calibrated decisions, and validate thresholds against a human-labelled sample before large runs.
7. Treat `review` and `invalid_response` separately; neither is an accepted classification.
