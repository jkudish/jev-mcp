#!/usr/bin/env node
// discern-mcp CLI: boots the MCP server over stdio (default) or stateless HTTP.
//
// This entry is the `discern-mcp` bin (also exported as `./bin` so the
// `@jkudish/jev-mcp` compat package can run it in-process); running it starts
// a transport. It is NOT the package's import entry: `exports` maps the root
// import to dist/server.js, which exposes `createServer()` without booting
// anything, so importing the package from another process never opens stdio
// or a listener.
//
// Configuration is validated before any transport starts. stdout carries the
// MCP protocol, so every diagnostic goes to stderr, one line each.

import { applyLegacyEnv, discernName } from "./env.js";

let legacy: readonly string[];
let server: typeof import("./server.js");
let toolNames: import("./server.js").ToolNames;
try {
  // The bin applies the JEV_* aliases to process.env before the server module
  // loads, so MODEL and every later read see the DISCERN_ names. A conflict is
  // reported as one fixed line instead of an uncaught stack.
  legacy = applyLegacyEnv();
  server = await import("./server.js");
  toolNames = server.resolveToolNames();
} catch (error) {
  console.error(`[discern-mcp] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

for (const name of legacy) {
  console.error(`[discern-mcp] ${name} is deprecated; rename it to ${discernName(name)}. JEV_* names stop working in 2.0.`);
}

const factory = () => server.createServer({ toolNames });

if (process.argv.includes("--http") || process.env.DISCERN_MCP_TRANSPORT === "http") {
  const { serveHttp } = await import("./http.js");
  const { url } = await serveHttp(factory);
  console.error(`[discern-mcp] ready — model ${server.MODEL}, ${toolNames}_* tools, stateless HTTP at ${url}`);
} else {
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  serveStdio(factory);
  console.error(`[discern-mcp] ready — model ${server.MODEL}, ${toolNames}_* tools`);
}
