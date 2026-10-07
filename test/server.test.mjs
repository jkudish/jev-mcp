// Entry-point split (#49): importing the package must register the tools
// without starting a transport; the bin entry (dist/index.js) keeps booting
// one when run. All no-boot assertions run in child processes bounded by a
// timeout, so a boot regression fails fast instead of hanging the suite.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const rootEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// Exit codes distinguish failures inside the child so the assertion message
// names the defect, not just "child failed".
const CHILD_PROGRAM = `
  for (const spec of ["@jkudish/discern-mcp", "@jkudish/discern-mcp/server"]) {
    const m = await import(spec);
    if (typeof m.createServer !== "function") process.exit(2);
    if (typeof m.MODEL !== "string" || !m.MODEL) process.exit(3);
    const a = m.createServer();
    const b = m.createServer();
    if (a === b || typeof a.registerTool !== "function" || typeof b.registerTool !== "function") process.exit(4);
  }
`;

test("the root and /server entries import without booting a transport", async () => {
  // A child process is the honest witness: if the import started a stdio
  // transport the child would hold stdin open and hit the timeout instead of
  // exiting 0; if it booted HTTP it would listen, same outcome. The banner
  // assertion catches a boot that somehow stays idle.
  await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", CHILD_PROGRAM],
      { cwd: packageRoot, timeout: 15_000 },
      (error, _stdout, stderr) => {
        if (error) {
          const reason = { 2: "createServer missing", 3: "MODEL missing", 4: "createServer not a fresh-instance factory" }[error.code] ?? "import failed";
          return reject(new Error(`${reason}: ${stderr}`));
        }
        assert.doesNotMatch(stderr ?? "", /\[discern-mcp\] ready/, "an import entry must not print the boot banner");
        resolve();
      },
    );
  });
});

test("the bin entry still boots and prints the ready banner", async () => {
  await new Promise((resolve, reject) => {
    // Force the stdio branch: an ambient DISCERN_MCP_TRANSPORT=http would point
    // this smoke test at the HTTP path and its HOST/token requirements.
    const child = spawn(process.execPath, [rootEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DISCERN_MCP_TRANSPORT: "stdio" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("[discern-mcp] ready")) {
        child.kill("SIGTERM");
        resolve();
      }
    });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`bin entry never became ready; stderr so far: ${stderr}`));
    }, 15_000);
    child.on("exit", () => clearTimeout(timer));
  });
});
