# Classify Exa search results with Discern

Exa retrieves pages; `discern_classify` assigns a page type from a shared catalog.
This source-checkout example preserves source URLs, removes duplicate URLs
(ignoring fragments), bounds each excerpt to 2,000 characters, and splits large
saved searches into batches of at most 64 items. Five classes stay below the
server's 8,000 item-class budget.

Run from the repository root with Node.js 22+:

```sh
npm ci
# Offline input preparation; the fixture is synthetic, not measured Exa output.
node examples/exa-classify.mjs --file examples/exa-sample.json --dry-run

# Set EXA_API_KEY and TYPESAFE_API_KEY in your shell, then:
node examples/exa-classify.mjs --query "Open source tools and tutorials for typed LLM classification" > results.json

# Reuse a saved Exa /search response (requires only TYPESAFE_API_KEY):
node examples/exa-classify.mjs --file saved-exa-response.json > results.json
```

The direct search uses Exa's documented [`POST /search`](https://docs.exa.ai/reference/search)
endpoint and requests ten pages with text. `--query --dry-run` still performs a
live Exa search and needs its key; only the classification step is skipped. Exa connector
access does not automatically provide an `EXA_API_KEY` to this script. A saved
file must have a `results` array containing `url`, optional `title`, and `text`
or `highlights`; prose connector output needs conversion to that shape first.

This example explicitly selects the TypeSafe provider (Jev). Optional
`DISCERN_MCP_MODEL` pins a model version for comparisons; a legacy
`JEV_MCP_MODEL` is still read through the 1.x alias. The MCP client forwards
only the provider settings it needs. Exa's key is not sent to the discern-mcp
subprocess. Fetched excerpts are sent to TypeSafe as classification inputs.

Alternatively put `TYPESAFE_API_KEY=...` (and `EXA_API_KEY=...` for live search)
in the git-ignored `.env` file and run `node --env-file=.env
examples/exa-classify.mjs --file saved-exa-response.json`. Do not commit keys or
include them in result files.

The output retains every judgment, probability distribution, source excerpt,
truncation flag, and per-batch model/provider/usage metadata. `classification_ms`
measures all classification batches including MCP overhead, excluding search
and server startup; `exa_cost` records search cost when Exa supplies it.

The application routes `manual_review` to review even if the model confidently chose
that class. Empty excerpts and invalid answers also go to review. Other labels
use the tool's default probability and margin thresholds. Page type is not a verdict
on relevance, truth, or safety, and a screening model is not a security boundary.

## A small reproducible experiment

1. Save a fixed Exa search response and manually label its excerpts using this
   catalog. Include tutorials, API docs, research, unrelated pages, and ambiguous
   excerpts. These are reference labels, not model outputs.
2. Freeze the labels and source text before classifying. Use a pinned model.
3. Compare classifications with those labels: overall accuracy, the fraction
   routed automatically, accuracy among those automatic decisions, and review
   rate. Count invalid responses separately. Do not count `manual_review` as an
   automatically accepted label.
4. Compare text versus highlights and, on a separate development set, generic
   class descriptions versus explicit definitions and precedence. Keep the final
   evaluation set untouched when tuning descriptions or thresholds.
5. Record model, prompt/catalog, tokens, search cost, and elapsed time. Repeat
   before making latency or calibration claims; a tiny sample is only a smoke test.

Offline adapter checks run as part of `npm test`. They use controlled responses
and establish integration behavior, not model accuracy. A live run needs keys;
no quality or latency benchmark is claimed by the fixture.
