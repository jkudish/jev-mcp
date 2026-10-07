// The @jkudish/jev-mcp compat package (compat/jev-mcp) installed the way npm
// lays it out: its own files under node_modules/@jkudish/jev-mcp, with
// @jkudish/discern-mcp (this checkout) as a sibling dependency.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const compatSource = join(repoRoot, "compat", "jev-mcp");
const SUFFIXES = ["audit", "classify", "compare", "decide", "extract", "find", "gate", "noul", "rerank", "review", "screen", "verify"];
const names = (prefix) => SUFFIXES.map((suffix) => `${prefix}_${suffix}`);

let installRoot;
let compatDir;
before(async () => {
  installRoot = await mkdtemp(join(tmpdir(), "jev-mcp-compat-"));
  const scope = join(installRoot, "node_modules", "@jkudish");
  await mkdir(scope, { recursive: true });
  compatDir = join(scope, "jev-mcp");
  await cp(compatSource, compatDir, { recursive: true });
  await symlink(repoRoot, join(scope, "discern-mcp"), "dir");
});
after(() => rm(installRoot, { recursive: true, force: true }));

async function listedTools(env) {
  const pkg = JSON.parse(await readFile(join(compatDir, "package.json"), "utf8"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(compatDir, pkg.bin["jev-mcp"])],
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "test-key", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "compat-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return {
      server: client.getServerVersion()?.name,
      names: (await client.listTools()).tools.map((t) => t.name).sort(),
      // A discern_* call must reach the tool (input validation), not "not found".
      discernCall: await client.callTool({ name: "discern_noul", arguments: {} }),
    };
  } finally {
    await client.close();
  }
}

test("compat package metadata names @jkudish/jev-mcp 1.0.0 with the jev-mcp bin over discern-mcp ^1.0.0", async () => {
  const pkg = JSON.parse(await readFile(join(compatSource, "package.json"), "utf8"));
  assert.equal(pkg.name, "@jkudish/jev-mcp");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.dependencies["@jkudish/discern-mcp"], "^1.0.0");
  assert.equal(pkg.bin["jev-mcp"], "bin/jev-mcp.js");
  // Root package version must satisfy the compat dependency it ships with.
  const root = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  assert.equal(root.version, "1.0.0");
  assert.ok(!root.files.some((entry) => entry.startsWith("compat")), "compat/ must not ship in the root package");
});

test("the jev-mcp bin lists jev_* tools and keeps discern_* callable", async () => {
  const result = await listedTools({});
  assert.equal(result.server, "discern-mcp");
  assert.deepEqual(result.names, names("jev"));
  assert.doesNotMatch(result.discernCall.content[0].text, /not found|disabled/i);
});

test("an explicit DISCERN_TOOL_NAMES overrides the compat default", async () => {
  assert.deepEqual((await listedTools({ DISCERN_TOOL_NAMES: "discern" })).names, names("discern"));
});

test("the compat library entry re-exports discern-mcp's server", async () => {
  const program = `
    const compat = await import("@jkudish/jev-mcp/server");
    const root = await import("@jkudish/jev-mcp");
    const discern = await import("@jkudish/discern-mcp/server");
    if (compat.createServer !== discern.createServer || root.createServer !== discern.createServer) process.exit(2);
    if (compat.MODEL !== discern.MODEL) process.exit(3);
  `;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", program], { cwd: installRoot, timeout: 15_000 });
});
