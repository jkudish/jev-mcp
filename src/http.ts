// Opt-in stateless Streamable HTTP transport (`discern-mcp --http`).
//
// Serves MCP 2026-07-28 per request and 2025-era clients through the SDK's
// stateless fallback: no sessions, no Mcp-Session-Id, nothing held between
// requests, so any number of replicas can sit behind a plain load balancer.
import { createServer as createNodeServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

// Fixed-string rejection: never echo the rejected Host/Origin back (reflection
// of attacker-controlled values), unlike the SDK's guards.
const FORBIDDEN_BODY = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden" }, id: null });
function forbidden(res: import("node:http").ServerResponse) {
  res.writeHead(403, { "content-type": "application/json" }).end(FORBIDDEN_BODY);
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let hostname = host.toLowerCase();
  const bracketed = hostname.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) hostname = bracketed[1];
  else hostname = hostname.replace(/:\d+$/, "");
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

export async function serveHttp(factory: () => McpServer, env: NodeJS.ProcessEnv = process.env) {
  // Loopback by default: binding a public interface is an explicit act.
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 8080);
  const token = Buffer.from(env.DISCERN_MCP_AUTH_TOKEN ?? "");
  const maxInFlight = Number(env.DISCERN_MCP_MAX_CONCURRENCY ?? 16);
  // Opt-in for clients that can only be configured with a URL (claude.ai custom
  // connectors, some cloud agents): the token may also arrive as /mcp/<token>.
  const pathToken = env.DISCERN_MCP_PATH_TOKEN === "1";
  // The server spends the operator's provider key on every call; never expose it unauthenticated.
  if (token.length === 0 && !LOOPBACK.has(host)) {
    throw new Error("DISCERN_MCP_AUTH_TOKEN is required when HTTP mode binds a non-loopback HOST");
  }
  if (pathToken && token.length === 0) {
    throw new Error("DISCERN_MCP_PATH_TOKEN requires DISCERN_MCP_AUTH_TOKEN");
  }
  // The path form compares the segment raw, so a token containing characters
  // a client may percent-encode could never match. Refuse at startup instead.
  if (pathToken && /[^\w.\-~]/.test(env.DISCERN_MCP_AUTH_TOKEN ?? "")) {
    throw new Error("DISCERN_MCP_PATH_TOKEN requires a URL-safe token (letters, digits, . _ - ~)");
  }
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error("DISCERN_MCP_MAX_CONCURRENCY must be a positive integer");
  }

  const matches = (candidate: string) => {
    const given = Buffer.from(candidate);
    return given.length === token.length && timingSafeEqual(given, token);
  };
  const authorized = (header: string | undefined, fromPath: string | undefined) => {
    if (token.length === 0) return true;
    // The path segment is compared raw, never URI-decoded: decoding throws on
    // malformed escapes, and a throw here would take down the process.
    if (fromPath !== undefined) return matches(fromPath);
    return matches(header?.startsWith("Bearer ") ? header.slice(7) : "");
  };

  // On loopback, reject foreign Host/Origin headers so a web page cannot reach
  // the server through DNS rebinding (the spec's Origin-validation MUST).
  const onLoopback = LOOPBACK.has(host);

  const mcp = toNodeHandler(
    createMcpHandler(factory, {
      // The tool list never changes: refuse subscriptions/listen in-band
      // instead of letting a client park an idle SSE stream on a slot.
      maxSubscriptions: 0,
      onerror: (error) => console.error(`[discern-mcp] http: ${error.message}`),
    }),
    {
      onerror: (error) => console.error(`[discern-mcp] http: ${error.message}`),
    },
  );

  let inFlight = 0;
  const server = createNodeServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const fromPath = pathToken && path.startsWith("/mcp/") ? path.slice("/mcp/".length) : undefined;
    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    } else if (path !== "/mcp" && fromPath === undefined) {
      res.writeHead(404).end();
    } else if (onLoopback && (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin))) {
      forbidden(res);
    } else if (!authorized(req.headers.authorization, fromPath)) {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end();
    } else if (inFlight >= maxInFlight) {
      // Backpressure: each in-flight request replays tools and may spend the
      // operator's provider key; shed load instead of queueing it.
      res.writeHead(429, { "retry-after": "1" }).end();
    } else {
      inFlight++;
      // The token never travels past auth: rewrite the authenticated URL so
      // the SDK's Request (and any diagnostics built from it) sees /mcp only.
      if (fromPath !== undefined) req.url = "/mcp";
      void mcp(req, res)
        .catch((error) => {
          // toNodeHandler reports its own failures through onerror; a promise
          // rejection here must not become an unhandled one that kills Node.
          console.error(`[discern-mcp] http: ${(error as Error)?.message ?? error}`);
          res.destroy();
        })
        .finally(() => inFlight--);
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const { port: bound, address: boundAddress } = server.address() as AddressInfo;
  // "localhost" must actually resolve to loopback; a poisoned resolver must not
  // silently turn a loopback bind into a public one.
  if (onLoopback && boundAddress !== "127.0.0.1" && boundAddress !== "::1" && boundAddress !== "::ffff:127.0.0.1") {
    server.close();
    throw new Error(`HOST ${host} resolved to non-loopback ${boundAddress}; refusing to serve`);
  }
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { server, url: `http://${host.includes(":") ? `[${host}]` : host}:${bound}/mcp` };
}
