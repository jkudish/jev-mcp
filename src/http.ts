// Opt-in stateless Streamable HTTP transport (`jev-mcp --http`).
//
// Serves MCP 2026-07-28 per request and 2025-era clients through the SDK's
// stateless fallback: no sessions, no Mcp-Session-Id, nothing held between
// requests, so any number of replicas can sit behind a plain load balancer.
import { createServer as createNodeServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export async function serveHttp(factory: () => McpServer, env: NodeJS.ProcessEnv = process.env) {
  const host = env.HOST || "0.0.0.0";
  const port = Number(env.PORT || 8080);
  const token = Buffer.from(env.JEV_MCP_AUTH_TOKEN ?? "");
  // The server spends the operator's Jev key on every call; never expose it unauthenticated.
  if (token.length === 0 && !LOOPBACK.has(host)) {
    throw new Error("JEV_MCP_AUTH_TOKEN is required when HTTP mode binds a non-loopback HOST");
  }

  const authorized = (header: string | undefined) => {
    if (token.length === 0) return true;
    const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
    return given.length === token.length && timingSafeEqual(given, token);
  };

  // On loopback, reject foreign Host/Origin headers so a web page cannot reach
  // the server through DNS rebinding (the spec's Origin-validation MUST).
  const guards = LOOPBACK.has(host) ? [localhostHostValidation(), localhostOriginValidation()] : [];

  const mcp = toNodeHandler(createMcpHandler(factory), {
    onerror: (error) => console.error(`[jev-mcp] http: ${error.message}`),
  });

  const server = createNodeServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    } else if (path !== "/mcp") {
      res.writeHead(404).end();
    } else if (!guards.every((guard) => guard(req, res))) {
      return;
    } else if (!authorized(req.headers.authorization)) {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end();
    } else {
      void mcp(req, res);
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const { port: bound } = server.address() as AddressInfo;
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { server, url: `http://${host.includes(":") ? `[${host}]` : host}:${bound}/mcp` };
}
