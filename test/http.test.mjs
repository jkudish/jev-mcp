import { request } from "node:http";
import { connect } from "node:net";
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

test("--http on loopback without a token rejects a foreign Host or Origin (DNS rebinding)", async () => {
  const { url, stop } = await startHttp({ HOST: "127.0.0.1", PORT: "0" });
  // node:http, not fetch: fetch silently drops a caller-set Host header.
  const post = (extra) =>
    new Promise((resolve, reject) => {
      const req = request(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...extra },
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
  try {
    for (const extra of [{ host: "evil.example" }, { origin: "https://evil.example" }]) {
      const { status, body } = await post(extra);
      assert.equal(status, 403);
      // Fixed-string rejection: the attacker-controlled value must not be echoed.
      assert.ok(!body.includes("evil.example"), `reflected rejection value in body: ${body}`);
      assert.equal(JSON.parse(body).error.message, "Forbidden");
    }
  } finally {
    await stop();
  }
});

test("--http defaults to a loopback bind when HOST is unset", async () => {
  const child = spawn(process.execPath, [serverPath, "--http"], {
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "test-key", PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  try {
    const url = await new Promise((resolve, reject) => {
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const match = stderr.match(/stateless HTTP at (\S+)/);
        if (match) resolve(new URL(match[1]));
      });
      child.once("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
    });
    assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname), `non-loopback default bind: ${url.hostname}`);
  } finally {
    child.kill("SIGTERM");
  }
});

test("--http sheds load with 429 past JEV_MCP_MAX_CONCURRENCY", async () => {
  const { url, stop } = await startHttp({ JEV_MCP_MAX_CONCURRENCY: "1", JEV_MCP_AUTH_TOKEN: TOKEN });
  // Hold the one permitted slot open mid-body: raw socket, headers sent, body withheld.
  const held = connect({ host: url.hostname, port: Number(url.port) });
  await once(held, "connect");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  held.write(
    `POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${TOKEN}\r\n` +
    `Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${body.length}\r\n\r\n`,
  );
  const post = (headers) =>
    new Promise((resolve, reject) => {
      const req = request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    });
  const authed = () => post({ authorization: `Bearer ${TOKEN}` });
  // Bounded retry: the slot frees when the held response is written, which can
  // land just after the first probe observes the headers.
  const authedEventually = async () => {
    for (let i = 0; i < 20; i++) {
      if ((await authed()) === 200) return 200;
      await new Promise((r) => setTimeout(r, 50));
    }
    return await authed();
  };
  try {
    // Auth is checked before the cap: a bad credential gets 401 even when full.
    assert.equal(await post({ authorization: "Bearer wrong-token" }), 401);
    assert.equal(await post({}), 401);
    assert.equal(await authed(), 429);
    // Release the slot: finish the held body, wait for the response bytes (the
    // SSE response keeps the socket open, so "close" would never fire), then
    // drop the socket — freeing the slot happens when the response is written.
    held.on("error", () => {});
    held.end(body);
    await once(held, "data");
    held.destroy();
    assert.equal(await authedEventually(), 200);
  } finally {
    held.destroy();
    await stop();
  }
});
