import { createServer as createMockServer, request } from "node:http";
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

test("--http refuses a non-loopback bind without DISCERN_MCP_AUTH_TOKEN", async () => {
  const child = spawn(process.execPath, [serverPath, "--http"], {
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "test-key", HOST: "0.0.0.0", PORT: "0" },
    stdio: "ignore",
  });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
});

test("--http serves 2025-era and 2026-07-28 clients statelessly behind a bearer token", async () => {
  const { url, stop } = await startHttp({ DISCERN_MCP_AUTH_TOKEN: TOKEN });
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
    assert.equal(legacy.names.length, 13);
    assert.ok(legacy.names.includes("discern_verify"));

    const modern = await listTools(url, { mode: { pin: "2026-07-28" } });
    assert.equal(modern.era, "modern");
    assert.deepEqual(modern.names, legacy.names);
  } finally {
    await stop();
  }
});

test("--http localizes images in both protocol eras and rejects image/auth/body violations before inference", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 17]);
  const image = { mime_type: "image/png", data_base64: bytes.toString("base64") };
  const box = { top: 0.13, bottom: 0.72, left: 0.61, right: 0.89 };
  let calls = 0;
  const provider = createMockServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      calls++;
      const body = JSON.parse(raw);
      assert.equal(body.assets[body.state.image].data_base64, image.data_base64);
      assert.equal(body.questions.location.type, "box");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "jev-1.14.0", usage: { input_tokens: 11, output_tokens: 7 }, answers: {
        present: { type: "noul", noul: 0.94 }, unique: { type: "noul", noul: 0.92 },
        location: { type: "box", box, confidence: 0.91 },
      } }));
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  let stop;
  try {
    const running = await startHttp({ DISCERN_MCP_AUTH_TOKEN: TOKEN, TYPESAFE_BASE_URL: `http://127.0.0.1:${provider.address().port}` });
    stop = running.stop;
    const args = { image, target: "the red rectangle", model: "jev-1.14.0" };
    for (const versionNegotiation of [undefined, { mode: { pin: "2026-07-28" } }]) {
      const client = new Client({ name: "http-image-test", version: "1.0.0" }, versionNegotiation ? { versionNegotiation } : {});
      await client.connect(new StreamableHTTPClientTransport(running.url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
      try {
        const result = await client.callTool({ name: "discern_locate_image", arguments: args });
        assert.notEqual(result.isError, true);
        const body = JSON.parse(result.content[0].text);
        assert.equal(body.status, "located"); assert.equal(body.action, "review");
        assert.deepEqual(body.box, box); assert.equal(body.model, "jev-1.14.0");
        assert.deepEqual(body.usage, { input_tokens: 11, output_tokens: 7 });
        assert.ok(!JSON.stringify(result).includes(image.data_base64));
        const large = Buffer.alloc(1024 * 1024 + 1); bytes.copy(large);
        const invalid = await client.callTool({ name: "discern_locate_image", arguments: { ...args, image: { ...image, data_base64: large.toString("base64") } } });
        assert.equal(invalid.isError, true);
      } finally { await client.close(); }
    }
    assert.equal(calls, 2);
    const rpc = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "discern_locate_image", arguments: args } };
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
    const denied = await fetch(running.url, { method: "POST", headers, body: JSON.stringify(rpc) });
    assert.equal(denied.status, 401); await denied.text();
    rpc.params.arguments = { ...args, context: "x".repeat(4 * 1024 * 1024) };
    // The server rejects Content-Length before reading. Send headers only:
    // fetch can lose the 413 to EPIPE while still uploading the rejected body.
    const oversized = await new Promise((resolve, reject) => {
      const req = request(running.url, { method: "POST", headers: {
        ...headers, Authorization: `Bearer ${TOKEN}`, "Content-Length": Buffer.byteLength(JSON.stringify(rpc)),
      } }, res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("oversized request headers were not rejected")));
      req.end();
    });
    assert.equal(oversized, 413);
    assert.equal(calls, 2);
    assert.equal((await fetch(new URL("/health", running.url))).status, 200);
  } finally {
    if (stop) await stop();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
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

test("--http advertises a static tool list and refuses subscriptions/listen without holding a slot", async () => {
  const { url, stop } = await startHttp({ DISCERN_MCP_MAX_CONCURRENCY: "1", DISCERN_MCP_AUTH_TOKEN: TOKEN });
  try {
    const client = new Client(
      { name: "listen-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }),
    );
    try {
      // A static tool list advertises no listChanged, so capable clients have
      // no reason to open a listener; an explicit one is refused in-band...
      assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);
      await assert.rejects(
        client.listen({ notifications: { tools: true } }),
        (error) => /subscription|limit|not/i.test(String(error?.message ?? error)),
      );
      // ...and the refused listener must not occupy the single concurrency slot.
      assert.equal((await client.listTools()).tools.length, 13);
    } finally {
      await client.close();
    }
  } finally {
    await stop();
  }
});

test("--http sheds load with 429 past DISCERN_MCP_MAX_CONCURRENCY", async () => {
  const { url, stop } = await startHttp({ DISCERN_MCP_MAX_CONCURRENCY: "1", DISCERN_MCP_AUTH_TOKEN: TOKEN });
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

// Raw request so the path reaches the server byte-for-byte (no URL normalization).
function rawPost(url, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers,
    } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
}

test("--http ignores /mcp/<token> unless DISCERN_MCP_PATH_TOKEN=1", async () => {
  const { url, stop } = await startHttp({ DISCERN_MCP_AUTH_TOKEN: TOKEN });
  try {
    assert.equal(await rawPost(url, `/mcp/${TOKEN}`), 404);
  } finally {
    await stop();
  }
});

test("--http with DISCERN_MCP_PATH_TOKEN=1 accepts /mcp/<token> and rejects wrong or malformed tokens", async () => {
  const { url, stop } = await startHttp({ DISCERN_MCP_AUTH_TOKEN: TOKEN, DISCERN_MCP_PATH_TOKEN: "1" });
  try {
    assert.equal(await rawPost(url, `/mcp/${TOKEN}`), 200);
    assert.equal(await rawPost(url, "/mcp/wrong-token"), 401);
    // A malformed escape must be a plain 401, not a URIError that kills the process.
    assert.equal(await rawPost(url, "/mcp/%E0%A4%A"), 401);
    assert.equal(await rawPost(url, `/mcp/${TOKEN}/extra`), 401);
    assert.equal(await rawPost(url, "/mcp", { authorization: `Bearer ${TOKEN}` }), 200);
    assert.equal(await rawPost(url, "/mcp"), 401);
    assert.equal((await fetch(new URL("/health", url))).status, 200);
  } finally {
    await stop();
  }
});

test("--http path-token credentials take precedence over headers when both are present", async () => {
  const { url, stop } = await startHttp({ DISCERN_MCP_AUTH_TOKEN: TOKEN, DISCERN_MCP_PATH_TOKEN: "1" });
  try {
    // A wrong path token is rejected even with a correct bearer header: the
    // path form is an alternative credential, not a second factor.
    assert.equal(await rawPost(url, "/mcp/wrong-token", { authorization: `Bearer ${TOKEN}` }), 401);
    // A correct path token authorizes even with a wrong header.
    assert.equal(await rawPost(url, `/mcp/${TOKEN}`, { authorization: "Bearer wrong" }), 200);
    // A query string never supplies or invalidates the credential.
    assert.equal(await rawPost(url, `/mcp/${TOKEN}?x=1`), 200);
  } finally {
    await stop();
  }
});

test("--http refuses DISCERN_MCP_PATH_TOKEN=1 without DISCERN_MCP_AUTH_TOKEN", { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, [serverPath, "--http"], {
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "test-key", HOST: "127.0.0.1", PORT: "0", DISCERN_MCP_PATH_TOKEN: "1" },
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
});
