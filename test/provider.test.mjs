import assert from "node:assert/strict";
import { test } from "node:test";
import { ask } from "@jkudish/jev-agent-tools";

test("shared wire validator distinguishes a malformed judgment from a failed request", async () => {
  const input = {
    state: "example",
    questions: { decision: { type: "choice", criteria: { yes: "yes", no: "no" } } },
    model: "jev-latest",
    signal: new AbortController().signal,
  };
  const invalid = await ask(input, { transport: {
    name: "fixture",
    async ask() {
      return { answers: { decision: { type: "choice", choice: "yes", probabilities: { yes: 0.1, no: 0.9 } } },
        usage: { input_tokens: 1, output_tokens: 1 }, model: "jev-latest" };
    },
  } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "invalid_choice");

  const failed = await ask(input, { transport: { name: "fixture", async ask() { throw new Error("offline"); } } });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "request_failed");
});
