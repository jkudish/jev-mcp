// Opt-in smoke against the native /v1/decisions endpoint. A missing key skips
// the test, and model-dependent choices are not asserted as ground truth.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("native OpenAI Decisions evaluates text, an inline image and requirement checks", { skip: !process.env.OPENAI_API_KEY }, async () => {
  const client = new Client({ name: "openai-decisions-live", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: {
      JEV_PROVIDER: "openai", OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ...Object.fromEntries(["JEV_MCP_MODEL", "JEV_OPENAI_BASE_URL"].filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
    },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "jev_decide", arguments: {
      decision: "Is there enough visual evidence to release a product?",
      evidence: "The image is a synthetic one-pixel placeholder and contains no product inspection evidence.",
      priorities: "Do not assume an unseen product is intact; investigate insufficient evidence.",
      candidates: [
        { id: "release", description: "Release a product whose intact condition is established." },
        { id: "hold", description: "Hold a product whose visible damage is established." },
      ],
      requirements: ["The image establishes the product condition."],
      images: [{ id: "placeholder", data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }],
    } }, { timeout: 75_000 });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const body = JSON.parse(result.content.find((part) => part.type === "text").text);
    assert.equal(body.provider, "openai");
    assert.notEqual(body.recommendation.status, "invalid_response");
    assert.ok(["release", "hold", "ask_user", "investigate", "none"].includes(body.recommendation.selected));
    assert.ok(body.recommendation.reason.length > 0);
    assert.equal(body.checks.length, 2);
    assert.ok(body.checks.every((check) => ["supported", "contradicted", "unknown"].includes(check.answer)));
    assert.match(body.image_evidence[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(body.usage.input_tokens) && body.usage.input_tokens > 0);
  } finally {
    await client.close();
  }
});
