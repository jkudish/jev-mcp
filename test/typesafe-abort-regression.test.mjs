// Regression for typesafe-sdk-js#2: a handled systemOne cancellation after
// response headers must not terminate the process on Node 20/22. The SDK's
// bundled-undici clone/cancel path is fixed upstream in nodejs/undici#4804
// (bundled from Node 24), and provider.ts injects standalone undici into the
// SDK to carry that fix on every supported Node. On Node >= 24 this test
// passes trivially (the bug is absent); CI's Node 22 job is where it bites.
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
  assert.match(out, /CAUGHT APIUserAbortError/);
  assert.match(out, /PASS normal process exit/);
});
