import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const TOKEN = "test-token-0123456789abcdef";

async function startHttp(env) {
  const child = spawn(process.execPath, [serverPath, "--http"], {
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "test-key", HOST: "127.0.0.1", PORT: "0", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  const url = await new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/stateless HTTP at (\S+)/);
      if (match) resolve(new URL(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
  });
  return { url, stop: async () => { child.kill("SIGTERM"); await once(child, "exit"); } };
}

async function listTools(url, versionNegotiation) {
  const client = new Client({ name: "http-test", version: "1.0.0" }, versionNegotiation ? { versionNegotiation } : {});
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }),
  );
  try {
    return { era: client.getProtocolEra(), names: (await client.listTools()).tools.map((t) => t.name) };
  } finally {
    await client.close();
  }
}

test("--http refuses a non-loopback bind without JEV_MCP_AUTH_TOKEN", async () => {
  const child = spawn(process.execPath, [serverPath, "--http"], {
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "test-key", HOST: "0.0.0.0", PORT: "0" },
    stdio: "ignore",
  });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
});

test("--http serves 2025-era and 2026-07-28 clients statelessly behind a bearer token", async () => {
  const { url, stop } = await startHttp({ JEV_MCP_AUTH_TOKEN: TOKEN });
  try {
    assert.equal((await fetch(new URL("/health", url))).status, 200);
    const denied = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(denied.status, 401);

    const legacy = await listTools(url);
    assert.equal(legacy.era, "legacy");
    assert.equal(legacy.names.length, 11);
    assert.ok(legacy.names.includes("jev_verify"));

    const modern = await listTools(url, { mode: { pin: "2026-07-28" } });
    assert.equal(modern.era, "modern");
    assert.deepEqual(modern.names, legacy.names);
  } finally {
    await stop();
  }
});
