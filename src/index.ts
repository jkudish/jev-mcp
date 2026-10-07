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

let env: typeof import("./env.js");
let server: typeof import("./server.js");
let toolNames: import("./server.js").ToolNames;
try {
  // Dynamic, so an env conflict thrown while the modules evaluate is caught
  // here and reported as one fixed line instead of an uncaught stack.
  env = await import("./env.js");
  server = await import("./server.js");
  toolNames = server.resolveToolNames();
} catch (error) {
  console.error(`[discern-mcp] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

for (const name of env.legacyEnvNames) {
  console.error(`[discern-mcp] ${name} is deprecated; rename it to ${env.discernName(name)}. JEV_* names stop working in 2.0.`);
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
