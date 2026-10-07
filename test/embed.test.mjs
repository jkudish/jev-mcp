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
    assert.equal(names.length, 13);
  }
});

test("an invalid toolNames option throws instead of listing nothing", () => {
  for (const toolNames of ["bogus", "Discern", ""]) {
    assert.throws(() => createServer({ toolNames }), /toolNames must be "discern" or "jev"/);
  }
});
