import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const TOKEN = "test-http-token-0123456789";
const TOOL_NAMES = [
  "jev_classify",
  "jev_compare",
  "jev_decide",
  "jev_extract",
  "jev_find",
  "jev_gate",
  "jev_rerank",
  "jev_review",
  "jev_screen",
  "jev_verify",
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    delay(timeoutMs).then(() => {
      child.kill();
      throw new Error(`server did not exit within ${timeoutMs}ms`);
    }),
  ]);
}

async function startHttpServer({ token = TOKEN, sessionTimeoutMs = 5_000 } = {}) {
  const env = { ...process.env };
  if (token === undefined) delete env.JEV_MCP_HTTP_BEARER_TOKEN;
  else env.JEV_MCP_HTTP_BEARER_TOKEN = token;

  const child = spawn(
    process.execPath,
    [
      serverPath,
      "--transport",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--session-timeout-ms",
      String(sessionTimeoutMs),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => (stdout += chunk));

  const ready = new Promise((resolve, reject) => {
    const inspect = () => {
      const match = stderr.match(/\[jev-mcp\] ready — http (http:\/\/\S+\/mcp) pid=(\d+)/);
      if (match) resolve({ url: match[1], pid: Number(match[2]) });
    };
    child.stderr.on("data", inspect);
    child.once("exit", (code, signal) => reject(new Error(`server exited before ready: code=${code} signal=${signal}\n${stderr}`)));
  });

  try {
    const info = await Promise.race([
      ready,
      delay(5_000).then(() => {
        throw new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }),
    ]);
    return { child, stderr: () => stderr, stdout: () => stdout, ...info };
  } catch (error) {
    child.kill();
    throw error;
  }
}

function makeClient(url, name) {
  const client = new Client({ name, version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  return { client, transport };
}

async function rawMcp(url, token, body, sessionId) {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("HTTP mode fails closed when its bearer token is missing", async () => {
  const env = { ...process.env };
  delete env.JEV_MCP_HTTP_BEARER_TOKEN;
  const child = spawn(process.execPath, [serverPath, "--transport", "http", "--port", "0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const { code } = await waitForExit(child);
  assert.notEqual(code, 0);
  assert.match(stderr, /JEV_MCP_HTTP_BEARER_TOKEN/);
});

test("one HTTP process serves two isolated MCP sessions", async (t) => {
  const server = await startHttpServer();
  assert.equal(server.pid, server.child.pid);
  assert.equal(server.stdout(), "", "HTTP mode must not write protocol or logs to stdout");
  t.after(async () => {
    if (server.child.exitCode === null) server.child.kill();
    if (server.child.exitCode === null) await waitForExit(server.child);
  });

  const health = await fetch(new URL("/healthz", server.url));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const unauthorized = await rawMcp(
    server.url,
    "wrong-token",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "unauthorized", version: "1" } },
    },
  );
  assert.equal(unauthorized.status, 401);

  const first = makeClient(server.url, "jev-http-a");
  const second = makeClient(server.url, "jev-http-b");
  await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);
  t.after(async () => {
    await Promise.allSettled([first.client.close(), second.client.close()]);
  });

  const [firstTools, secondTools] = await Promise.all([first.client.listTools(), second.client.listTools()]);
  assert.deepEqual(firstTools.tools.map((tool) => tool.name).sort(), TOOL_NAMES);
  assert.deepEqual(secondTools.tools.map((tool) => tool.name).sort(), TOOL_NAMES);

  const calls = await Promise.all(
    [first.client, second.client].map((client, index) =>
      client.callTool({
        name: "jev_extract",
        arguments: {
          document: `document ${index} has no version token`,
          fields: [{ id: "version", pattern: "v\\d+", description: "A version token" }],
        },
      }),
    ),
  );
  for (const result of calls) {
    const payload = JSON.parse(result.content.find((block) => block.type === "text").text);
    assert.equal(payload.tool, "jev_extract");
    assert.equal(payload.results[0].status, "not_found");
  }

  const firstSessionId = first.transport.sessionId;
  assert.ok(firstSessionId);
  await first.transport.terminateSession();
  const stale = await rawMcp(server.url, TOKEN, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, firstSessionId);
  assert.equal(stale.status, 404);
  assert.equal((await second.client.listTools()).tools.length, 10);

  const stopping = waitForExit(server.child);
  server.child.kill("SIGTERM");
  const stopped = await stopping;
  assert.ok(stopped.code === 0 || stopped.signal === "SIGTERM", `unexpected shutdown: ${JSON.stringify(stopped)}`);
});

test("idle HTTP sessions expire with a protocol-correct 404", async (t) => {
  const server = await startHttpServer({ sessionTimeoutMs: 100 });
  t.after(async () => {
    if (server.child.exitCode === null) server.child.kill();
    if (server.child.exitCode === null) await waitForExit(server.child);
  });
  const connection = makeClient(server.url, "jev-http-expiring");
  await connection.client.connect(connection.transport);
  t.after(async () => Promise.allSettled([connection.client.close()]));
  const sessionId = connection.transport.sessionId;
  assert.ok(sessionId);
  await delay(350);
  const stale = await rawMcp(server.url, TOKEN, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, sessionId);
  assert.equal(stale.status, 404);
});
