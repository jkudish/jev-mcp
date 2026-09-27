import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { prepareResults, classifyDocuments } from "../examples/exa-classify.mjs";

test("Exa normalization deduplicates fragments, falls back to highlights and bounds text", () => {
  const docs = prepareResults({ results: [
    { url: "https://example.org/a#one", text: "a".repeat(3000) },
    { url: "https://example.org/a#two", text: "duplicate" },
    { url: "https://example.org/b", text: " ", highlights: ["useful", null, "excerpt"] },
  ] });
  assert.equal(docs.length, 2);
  assert.equal(docs[0].text.length, 2000);
  assert.equal(docs[0].truncated, true);
  assert.equal(docs[0].url, "https://example.org/a#one");
  assert.match(docs[1].text, /useful\nexcerpt/);
  assert.throws(() => prepareResults({}), /results array/);
  assert.throws(() => prepareResults({ results: [{ url: "file:///tmp/foo" }] }), /HTTP/);
});

test("65 sources use two bounded batches, join by ID, and retain review outcomes", async () => {
  const documents = prepareResults({ results: Array.from({ length: 65 }, (_, i) => ({ url: `https://example.org/${i}`, text: i === 4 ? "" : "Some evidence" })) });
  const sizes = [];
  const result = await classifyDocuments(documents, async ({ arguments: args }) => {
    sizes.push(args.items.length);
    return { content: [{ type: "text", text: JSON.stringify({ results: args.items.map(({ id }) => ({
      id, classification: id === "source1" ? "manual_review" : "library",
      status: id === "source2" ? "invalid_response" : undefined,
      decision: id === "source3" ? "review" : "auto",
    })).reverse(), model: "mock-only", usage: { input_tokens: 1 } }) }] };
  });
  assert.deepEqual(sizes, [64, 1]);
  assert.equal(result.rows[0].route, "auto");
  for (let i = 1; i <= 4; i++) assert.equal(result.rows[i].route, "review");
  assert.equal(result.rows[64].url, "https://example.org/64");
  assert.equal(result.batches.length, 2);
});

test("missing, duplicate, or unknown response IDs cannot be silently joined", async () => {
  const docs = prepareResults({ results: [{ url: "https://example.org", text: "content" }] });
  for (const results of [[], [{ id: "other" }], [{ id: "source0" }, { id: "source0" }]]) {
    await assert.rejects(classifyDocuments(docs, async () => ({ content: [{ type: "text", text: JSON.stringify({ results }) }] })), /IDs/);
  }
  await assert.rejects(classifyDocuments(docs, async () => ({ isError: true })), /tool error/);
  assert.deepEqual(await classifyDocuments([], () => assert.fail("empty input called Jev")), { rows: [], batches: [] });
});

test("dry run needs neither API credential and reports no model judgments", () => {
  const result = JSON.parse(execFileSync(process.execPath, ["examples/exa-classify.mjs", "--file", "examples/exa-sample.json", "--dry-run"], {
    cwd: new URL("../", import.meta.url), env: {}, encoding: "utf8",
  }));
  assert.equal(result.mode, "prepared_only");
  assert.equal(result.documents.length, 3);
  assert.equal(result.rows, undefined);
});
