// Discern 1.x compatibility over a real MCP client: tool-name aliases
// (discern_* listed, jev_* callable, or the reverse with
// DISCERN_TOOL_NAMES=jev), result `tool` echo, and JEV_* env aliases.
//
// tools/list filtering wraps the SDK handler through a protected accessor (hideAliases in
// src/server.ts). These tests list and call through stdio and stateless HTTP,
// so an SDK change that breaks the wrapper fails here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const SUFFIXES = ["audit", "classify", "compare", "decide", "extract", "find", "gate", "noul", "rerank", "review", "screen", "verify"];
const names = (prefix) => SUFFIXES.map((suffix) => `${prefix}_${suffix}`);
const NOUL_ARGS = { propositions: ["Paris is the capital of France"] };

// A TypeSafe stand-in that answers every request with one Noul and records bodies.
async function startMock() {
  const requests = [];
  const http = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers: { p_proposition0: { noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    env: { TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: `http://127.0.0.1:${http.address().port}` },
    close: () => {
      http.close();
      http.closeAllConnections();
    },
  };
}

async function withStdio(env, fn) {
  const mock = await startMock();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { PATH: process.env.PATH, ...mock.env, ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "aliases-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client, { requests: mock.requests, stderr: () => stderr });
  } finally {
    await client.close();
    mock.close();
  }
}

// For startup failures: the process must exit on its own, so collect everything.
async function runToExit(env) {
  const child = spawn(process.execPath, [serverPath], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  return { code, stdout, stderr };
}

const payload = (result) => JSON.parse(result.content.find((block) => block.type === "text").text);

async function callNoul(client, name) {
  const result = await client.callTool({ name, arguments: NOUL_ARGS });
  assert.notEqual(result.isError, true, `${name} returned a tool error: ${JSON.stringify(result.content)}`);
  return payload(result);
}

test("by default tools/list advertises only discern_* and every jev_* alias stays callable", async () => {
  await withStdio({}, async (client) => {
    assert.equal(client.getServerVersion()?.name, "discern-mcp");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), names("discern"));
    // Cross-references in descriptions name the advertised prefix.
    const noul = tools.find((t) => t.name === "discern_noul");
    assert.match(noul.description, /discern_verify/);
    assert.doesNotMatch(noul.description, /jev_/);

    // The tool field echoes the name actually called, for both prefixes.
    assert.equal((await callNoul(client, "jev_noul")).tool, "jev_noul");
    assert.equal((await callNoul(client, "discern_noul")).tool, "discern_noul");
    // Every hidden alias is registered, not just the one exercised above.
    for (const name of names("jev")) {
      const result = await client.callTool({ name, arguments: {} });
      assert.doesNotMatch(result.content?.[0]?.text ?? "", /not found|disabled/i, `${name} is not callable`);
    }
  });
});

test("DISCERN_TOOL_NAMES=jev lists only jev_* while discern_* calls still succeed", async () => {
  await withStdio({ DISCERN_TOOL_NAMES: "jev" }, async (client, { stderr }) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), names("jev"));
    const noul = tools.find((t) => t.name === "jev_noul");
    assert.match(noul.description, /jev_verify/);
    assert.doesNotMatch(noul.description, /discern_/);

    assert.equal((await callNoul(client, "discern_noul")).tool, "discern_noul");
    assert.equal((await callNoul(client, "jev_noul")).tool, "jev_noul");
    assert.match(stderr(), /\[discern-mcp\] ready .*jev_\* tools/);
  });
});

test("an invalid DISCERN_TOOL_NAMES fails at startup without echoing the value", async () => {
  for (const value of ["both", "Discern", "secret-tool-names-value"]) {
    const { code, stdout, stderr } = await runToExit({ DISCERN_TOOL_NAMES: value });
    assert.equal(code, 1, `DISCERN_TOOL_NAMES=${value} should fail`);
    assert.equal(stdout, "", "stdout is reserved for the MCP protocol");
    assert.equal(stderr, '[discern-mcp] DISCERN_TOOL_NAMES must be "discern" or "jev".\n');
  }
});

test("legacy JEV_* variables keep working with one stderr deprecation line each", async () => {
  await withStdio({ JEV_MCP_MODEL: "legacy-model-value", JEV_PROVIDER: "typesafe", JEV_TOOL_NAMES: "jev" }, async (client, { requests, stderr }) => {
    // JEV_TOOL_NAMES aliases DISCERN_TOOL_NAMES.
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), names("jev"));
    // JEV_MCP_MODEL reaches the provider as DISCERN_MCP_MODEL.
    await callNoul(client, "jev_noul");
    assert.equal(requests.at(-1).model, "legacy-model-value");

    const deprecations = stderr().split("\n").filter((line) => line.includes("deprecated"));
    assert.deepEqual(deprecations, [
      "[discern-mcp] JEV_MCP_MODEL is deprecated; rename it to DISCERN_MCP_MODEL. JEV_* names stop working in 2.0.",
      "[discern-mcp] JEV_PROVIDER is deprecated; rename it to DISCERN_PROVIDER. JEV_* names stop working in 2.0.",
      "[discern-mcp] JEV_TOOL_NAMES is deprecated; rename it to DISCERN_TOOL_NAMES. JEV_* names stop working in 2.0.",
    ]);
  });
});

test("DISCERN_* names alone print no deprecation line, and a matching JEV_* twin is not a conflict", async () => {
  await withStdio({ DISCERN_MCP_MODEL: "same-model", JEV_PROVIDER: "", DISCERN_PROVIDER: "typesafe" }, async (client, { requests, stderr }) => {
    await callNoul(client, "discern_noul");
    assert.equal(requests.at(-1).model, "same-model");
    assert.doesNotMatch(stderr(), /deprecated/);
  });
  await withStdio({ DISCERN_MCP_MODEL: "same-model", JEV_MCP_MODEL: "same-model" }, async (client, { requests }) => {
    await callNoul(client, "discern_noul");
    assert.equal(requests.at(-1).model, "same-model");
  });
});

test("conflicting JEV_ and DISCERN_ values fail at startup without echoing either value", async () => {
  const { code, stdout, stderr } = await runToExit({
    TYPESAFE_API_KEY: "test-key",
    DISCERN_MCP_MODEL: "current-secret-value",
    JEV_MCP_MODEL: "legacy-secret-value",
  });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    "[discern-mcp] DISCERN_MCP_MODEL and JEV_MCP_MODEL are both set to different values; unset JEV_MCP_MODEL.\n",
  );
  assert.ok(!stderr.includes("secret-value"));
});

async function withHttp(env, fn) {
  const mock = await startMock();
  const child = spawn(process.execPath, [serverPath, "--http"], {
    env: { PATH: process.env.PATH, ...mock.env, HOST: "127.0.0.1", PORT: "0", ...env },
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
    const client = new Client({ name: "aliases-http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    mock.close();
  }
}

test("stateless HTTP lists only the advertised prefix and serves the hidden aliases", async () => {
  await withHttp({}, async (client) => {
    assert.equal(client.getServerVersion()?.name, "discern-mcp");
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), names("discern"));
    assert.equal((await callNoul(client, "jev_noul")).tool, "jev_noul");
  });
  await withHttp({ DISCERN_TOOL_NAMES: "jev" }, async (client) => {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), names("jev"));
    assert.equal((await callNoul(client, "discern_noul")).tool, "discern_noul");
  });
});
