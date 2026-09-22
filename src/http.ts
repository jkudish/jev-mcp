import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as NodeHttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { NextFunction, Request, Response } from "express";

export interface JevHttpOptions {
  host: string;
  port: number;
  path: string;
  bearerToken: string;
  sessionTimeoutMs: number;
  createServer: () => McpServer;
}

export interface JevHttpHandle {
  endpoint: string;
  close: () => Promise<void>;
}

interface SessionRecord {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastAccess: number;
  activeRequests: number;
  closing: boolean;
}

const jsonRpcError = (res: Response, status: number, code: number, message: string) => {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
};

const sessionIdFrom = (req: Request) => {
  const value = req.headers["mcp-session-id"];
  return typeof value === "string" ? value : undefined;
};

const tokenMatches = (actual: string | undefined, expected: string) => {
  if (!actual?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(actual.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
};

const bearerAuth = (token: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!tokenMatches(req.headers.authorization, token)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    jsonRpcError(res, 401, -32001, "Unauthorized");
    return;
  }
  next();
};

const closeNodeServer = (server: NodeHttpServer) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const formatEndpoint = (host: string, port: number, path: string) => {
  const printableHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${printableHost}:${port}${path}`;
};

export async function startJevHttpServer(options: JevHttpOptions): Promise<JevHttpHandle> {
  const { host, port, path, bearerToken, sessionTimeoutMs, createServer } = options;
  const app = createMcpExpressApp({ host });
  const sessions = new Map<string, SessionRecord>();
  let shuttingDown = false;

  const safeRoute =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response) => {
      void handler(req, res).catch((error) => {
        console.error(`[jev-mcp] HTTP request failed: ${error instanceof Error ? error.message : "unknown error"}`);
        if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
        else res.end();
      });
    };

  const closeSession = async (sessionId: string) => {
    const record = sessions.get(sessionId);
    if (!record || record.closing) return;
    record.closing = true;
    sessions.delete(sessionId);
    try {
      await record.server.close();
    } catch (error) {
      console.error(`[jev-mcp] session close failed id=${sessionId}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };

  const withSession = async (
    req: Request,
    res: Response,
    record: SessionRecord,
    body?: unknown,
    trackActivity = true,
  ) => {
    if (trackActivity) {
      record.activeRequests += 1;
      record.lastAccess = Date.now();
    }
    try {
      await record.transport.handleRequest(req, res, body);
    } finally {
      if (trackActivity) {
        record.activeRequests -= 1;
        record.lastAccess = Date.now();
      }
    }
  };

  const handlePost = async (req: Request, res: Response) => {
    if (shuttingDown) {
      jsonRpcError(res, 503, -32603, "Server is shutting down");
      return;
    }

    const sessionId = sessionIdFrom(req);
    if (sessionId) {
      const record = sessions.get(sessionId);
      if (!record) {
        jsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      await withSession(req, res, record, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      jsonRpcError(res, 400, -32000, "Missing session ID or initialize request");
      return;
    }

    const server = createServer();
    let record: SessionRecord;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (initializedId) => {
        sessions.set(initializedId, record);
      },
    });
    record = {
      server,
      transport,
      lastAccess: Date.now(),
      activeRequests: 0,
      closing: false,
    };
    transport.onclose = () => {
      const initializedId = transport.sessionId;
      if (initializedId) sessions.delete(initializedId);
    };
    transport.onerror = (error) => {
      console.error(`[jev-mcp] session transport error id=${transport.sessionId ?? "initializing"}: ${error.message}`);
    };

    try {
      await server.connect(transport);
      await withSession(req, res, record, req.body);
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }
  };

  const handleEstablishedSession = async (req: Request, res: Response) => {
    const sessionId = sessionIdFrom(req);
    if (!sessionId) {
      jsonRpcError(res, 400, -32000, "Missing session ID");
      return;
    }
    const record = sessions.get(sessionId);
    if (!record) {
      jsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    // A GET may hold an SSE stream open indefinitely. It is a delivery channel,
    // not proof that the client is still making requests, so it must not keep an
    // otherwise idle session alive forever.
    await withSession(req, res, record, undefined, req.method !== "GET");
  };

  const auth = bearerAuth(bearerToken);
  app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));
  app.post(path, auth, safeRoute(handlePost));
  app.get(path, auth, safeRoute(handleEstablishedSession));
  app.delete(path, auth, safeRoute(handleEstablishedSession));

  const cleanupEveryMs = Math.max(25, Math.min(Math.floor(sessionTimeoutMs / 2), 30_000));
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - sessionTimeoutMs;
    for (const [sessionId, record] of sessions) {
      if (record.activeRequests === 0 && record.lastAccess <= cutoff) void closeSession(sessionId);
    }
  }, cleanupEveryMs);
  cleanupTimer.unref();

  const httpServer = await new Promise<NodeHttpServer>((resolve, reject) => {
    const listening = app.listen(port, host, () => resolve(listening));
    listening.once("error", reject);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    clearInterval(cleanupTimer);
    await closeNodeServer(httpServer).catch(() => undefined);
    throw new Error("HTTP server did not expose a TCP address");
  }
  const endpoint = formatEndpoint(host, address.port, path);

  let closePromise: Promise<void> | undefined;
  const close = () => {
    if (!closePromise) {
      closePromise = (async () => {
        shuttingDown = true;
        clearInterval(cleanupTimer);
        const stoppedListening = closeNodeServer(httpServer);
        await Promise.all([...sessions.keys()].map(closeSession));
        // Session transports close their SSE streams first. Any remaining HTTP
        // keep-alive sockets must not keep a supervised process alive after its
        // shutdown signal.
        httpServer.closeAllConnections();
        await stoppedListening;
      })();
    }
    return closePromise;
  };

  return { endpoint, close };
}
