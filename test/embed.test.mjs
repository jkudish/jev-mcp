// Embedding: createServer() from the library entry, used in-process. Tools an
// embedder registers next to the judgment tools must be listed, and an invalid
// toolNames option must fail instead of building a server that lists nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as z from "zod";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../dist/server.js";

async function listed(server) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "embed-test", version: "1.0.0" });
  await client.connect(b);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  await client.close();
  return names;
}

test("tools an embedder registers are listed alongside the advertised prefix", async () => {
  for (const [toolNames, shown, hidden] of [["discern", "discern_verify", "jev_verify"], ["jev", "jev_verify", "discern_verify"]]) {
    const server = createServer({ toolNames });
    server.registerTool("my_custom", { description: "custom", inputSchema: z.object({}) }, async () => ({ content: [{ type: "text", text: "ok" }] }));
    const names = await listed(server);
    assert.ok(names.includes("my_custom"), `${toolNames}: ${names}`);
    assert.ok(names.includes(shown));
    assert.ok(!names.includes(hidden));
    assert.equal(names.length, 14);
  }
});

test("an invalid toolNames option throws instead of listing nothing", () => {
  for (const toolNames of ["bogus", "Discern", ""]) {
    assert.throws(() => createServer({ toolNames }), /toolNames must be "discern" or "jev"/);
  }
});

test("embedded image localization preserves bytes and keeps the hidden alias callable without an enable flag", async () => {
  const keys = ["DISCERN_PROVIDER", "TYPESAFE_API_KEY"];
  const saved = keys.map(key => process.env[key]);
  const nativeFetch = globalThis.fetch;
  const image = { mime_type: "image/png", data_base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 29]).toString("base64") };
  const box = { top: 0.13, bottom: 0.72, left: 0.61, right: 0.89 };
  let calls = 0;
  const client = new Client({ name: "embedded-image-test", version: "1.0.0" });
  try {
    process.env.DISCERN_PROVIDER = "typesafe";
    process.env.TYPESAFE_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.assets[body.state.image].data_base64, image.data_base64);
      return Response.json({ model: "jev-1.14.0", usage: { input_tokens: 13, output_tokens: 5 }, answers: {
        present: { type: "noul", noul: 0.96 }, unique: { type: "noul", noul: 0.93 },
        location: { type: "box", box, confidence: 0.94 },
      } });
    };
    const server = createServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const args = { image, target: "the right red rectangle", model: "jev-1.14.0" };
    const result = await client.callTool({ name: "jev_locate_image", arguments: args });
    assert.notEqual(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.tool, "jev_locate_image");
    assert.equal(body.status, "located"); assert.equal(body.action, "review");
    assert.deepEqual(body.box, box);
    assert.deepEqual(body.usage, { input_tokens: 13, output_tokens: 5 });
    assert.ok(!JSON.stringify(result).includes(image.data_base64));
    const unsupported = await client.callTool({ name: "discern_locate_image", arguments: { ...args, model: "jev-1.13.0" } });
    assert.equal(unsupported.isError, true);
    assert.match(unsupported.content[0].text, /does not support.*Box/);
    assert.equal(calls, 1);
  } finally {
    await client.close();
    globalThis.fetch = nativeFetch;
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});
