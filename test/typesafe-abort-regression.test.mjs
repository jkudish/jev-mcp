// A handled direct TypeSafe cancellation after response headers must not
// terminate the process. The package uses fetch rather than the old SDK's
// bundled-undici clone/cancel path (typesafe-sdk-js#2).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const fixture = fileURLToPath(new URL("./fixtures/typesafe-abort-child.mjs", import.meta.url));

test("handled typesafe cancellation after response headers exits the child process cleanly", async () => {
  const child = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, `child exited ${code}:\n${out}`);
  assert.match(out, /CAUGHT Error/);
  assert.match(out, /PASS normal process exit/);
});
