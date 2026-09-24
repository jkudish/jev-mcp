// Spawned by typesafe-abort-regression.test.mjs. Cancel the package's direct
// TypeSafe transport after headers while the response body is still streaming.
// The child must exit normally after the cancellation is handled.
import { createServer } from "node:http";
import { askJev } from "../../dist/provider.js";

process.env.JEV_PROVIDER = "typesafe";
process.env.TYPESAFE_API_KEY = "test-key";

const http = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"answers":{},"usage"'); // headers arrive, body still in flight
    setTimeout(() => res.end(':{ "input_tokens": 1, "output_tokens": 1 }'), 1500);
  });
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${http.address().port}`;

const controller = new AbortController();
setTimeout(() => controller.abort(), 300); // well after headers, mid-body

try {
  await askJev({ state: "s" }, { q: { type: "noul", instructions: "?" } }, "jev-latest", controller.signal);
  console.log("UNEXPECTED-RESOLVE");
} catch (error) {
  console.log(`CAUGHT ${error?.constructor?.name}`);
}

// Give any unhandled rejection time to surface before declaring success.
await new Promise((resolve) => setTimeout(resolve, 800));
console.log("PASS normal process exit");
http.close();
http.closeAllConnections();
process.exit(0);
