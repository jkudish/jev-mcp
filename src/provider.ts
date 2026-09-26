// Jev transport: TypeSafe direct (default), OpenRouter Decisions, Cloudflare
// Workers AI, or a caller-supplied Jev-compatible System One endpoint. All
// speak the {state, questions} / answers contract; URL, auth, and model slugs
// differ. Proxies add hops, so direct TypeSafe remains the recommended default.

import { ask, resolveTransport, type JevTransport, type JevTransportReply } from "@jkudish/jev-agent-tools";
import { isRecord } from "./lib.js";

export type JevProvider = "typesafe" | "openrouter" | "cloudflare" | "vercel" | "compatible";

export interface AskResult {
  answers: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number };
  provider: JevProvider;
  model: string;
}

const X_TITLE = "jev-mcp";
const REFERER = "https://github.com/jkudish/jev-mcp";

// Replace every occurrence of the secret so a reflecting endpoint cannot leak
// it into MCP-visible error text; covering the bare form also covers the
// "Bearer <secret>" form.
function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

// ── Transport resilience ─────────────────────────────────────────────────────
// Research and the original report: GitHub issue #23 by oppih. Applies to the
// fetch-based transports (openrouter, cloudflare, compatible); the typesafe
// and vercel branches go through SDK-owned transports whose retry and timeout
// semantics are theirs, so no uniformity is claimed for those.

const positiveIntFromEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
};

/** Whole-request deadline (all attempts), overridable for tests and tight hosts. */
const REQUEST_TIMEOUT_MS = positiveIntFromEnv("JEV_MCP_REQUEST_TIMEOUT_MS", 60_000);
/** Total attempts per request, including the first; clamped to 1..6. */
const MAX_ATTEMPTS = Math.min(6, Math.max(1, positiveIntFromEnv("JEV_MCP_MAX_ATTEMPTS", 3)));
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 4_000;
/** Stream-checked ceiling for success and error bodies alike. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** Only the not-processed status allowlist is retried, and 5xx means 500-599: out-of-range statuses are protocol noise, not retry signals. */
const isRetryableStatus = (status: number) => status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);

interface Deadline {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

/** One deadline covering every attempt; expiry and caller aborts never retry. */
function deadlineSignal(signal: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const relay = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) relay();
    else signal.addEventListener("abort", relay, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    },
  };
}

/** Jittered exponential backoff: 50-100% of the doubling delay, capped. */
function retryDelayMs(attempt: number): number {
  const exp = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
  return exp * (0.5 + Math.random() * 0.5);
}

/**
 * Backoff that ends early, without another attempt, when the deadline expires
 * or the caller aborts: the whole-request deadline must not be overrun by a
 * sleep, and a cancelled call must surface promptly.
 */
function backoffDelay(attempt: number, deadline: Deadline): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, retryDelayMs(attempt));
    const onAbort = () => {
      cleanup();
      reject(
        deadline.timedOut()
          ? new Error(`Jev request exceeded the ${REQUEST_TIMEOUT_MS}ms deadline.`)
          : deadline.signal.reason,
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      deadline.signal.removeEventListener("abort", onAbort);
    };
    if (deadline.signal.aborted) onAbort();
    else deadline.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Read a response body with the byte ceiling enforced while streaming.
 * Content-Length is advisory (and absent for chunked responses), so the
 * limit is enforced on the bytes actually read, on success and error paths
 * alike. Never retried: an oversized body is a protocol violation.
 */
async function readBodyBounded(response: Response, deadline: Deadline): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  // One abort watcher for the whole read, not one per chunk: a fragmented body
  // must not accumulate listeners and closures while it streams.
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        deadline.timedOut()
          ? new Error(`Jev request exceeded the ${REQUEST_TIMEOUT_MS}ms deadline while reading the response.`)
          : deadline.signal.reason,
      );
  });
  aborted.catch(() => {}); // stays handled when a read wins every race
  deadline.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (deadline.signal.aborted) onAbort();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes after reading ${total}; aborting the read.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    // The body reader races our watcher to the same abort and may reject
    // first with its raw AbortError; translate, exactly as the fetch catch
    // does, so deadline expiry reads as a deadline, not "operation aborted".
    if (deadline.signal.aborted) {
      throw deadline.timedOut()
        ? new Error(`Jev request exceeded the ${REQUEST_TIMEOUT_MS}ms deadline while reading the response.`)
        : deadline.signal.reason;
    }
    throw error;
  } finally {
    deadline.signal.removeEventListener("abort", onAbort);
    // On the success path the reader is already done; on throw this releases
    // the connection instead of leaking it.
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel on some runtimes.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Appends a fixed path to a configured API root. Both defaults carry path
 * prefixes, not just origins, and a conventional trailing slash must not
 * produce a "//path" request.
 */
function apiUrl(root: string, path: string): string {
  return `${root.replace(/\/+$/, "")}${path}`;
}

/**
 * Fetch with bounded, jittered retries on the 408/409/429/5xx allowlist only.
 * A status cannot prove the request was not processed, but that allowlist is
 * the standard not-processed signal set and the only retry trigger. Ambiguous
 * network-level failures (connection reset mid-response, TLS errors) never
 * retry: without an idempotency key, re-sending after an ambiguous failure can
 * double-process a paid call. Caller aborts and deadline expiry surface
 * immediately, cutting any backoff short, and never retry.
 */
async function fetchWithResilience(url: string, init: RequestInit, deadline: Deadline): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: deadline.signal });
    } catch (error) {
      if (deadline.timedOut()) {
        throw new Error(`Jev request exceeded the ${REQUEST_TIMEOUT_MS}ms deadline.`);
      }
      throw error; // caller cancellation or network failure: never re-sent
    }
    if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
      // Drain and release the connection before backing off.
      await response.body?.cancel().catch(() => {});
      await backoffDelay(attempt, deadline);
      continue;
    }
    return response;
  }
}

function resolve(env: NodeJS.ProcessEnv): JevProvider {
  const explicit = (env.JEV_PROVIDER ?? "auto").toLowerCase();
  const hasCompatible = Boolean(env.JEV_API_KEY && env.JEV_API_BASE_URL);
  if (explicit === "compatible") {
    const missing = ["JEV_API_KEY", "JEV_API_BASE_URL"].filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new Error(
        `JEV_PROVIDER=compatible but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. ` +
          "JEV_MCP_MODEL is optional and defaults to jev-latest.",
      );
    }
    return "compatible";
  }
  // The published package owns the four built-in credential rules and order.
  if ((explicit === "auto" || explicit === "") && hasCompatible &&
      !env.TYPESAFE_API_KEY && !/^sk-or-/.test(env.OPENROUTER_API_KEY ?? "") &&
      !((env.JEV_CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN) && env.CLOUDFLARE_ACCOUNT_ID) &&
      !env.AI_GATEWAY_API_KEY) return "compatible";
  return resolveTransport({ ...env, JEV_PROVIDER: explicit || "auto" }).name as JevProvider;
}

export async function askJev(
  state: unknown,
  questions: Record<string, unknown>,
  model: string,
  signal?: AbortSignal,
): Promise<AskResult> {
  const provider = resolve(process.env);

  if (provider === "typesafe" || provider === "vercel") {
    // Keep the raw envelope for MCP's per-judgment invalid_response behavior:
    // the shared package rejects a whole batch if even one answer is invalid.
    const builtin = resolveTransport({ ...process.env, JEV_PROVIDER: process.env.JEV_PROVIDER || "auto" });
    let reply: JevTransportReply | undefined;
    const transport: JevTransport = {
      name: builtin.name,
      async ask(input) {
        try {
          return reply = await builtin.ask(input);
        } catch (error) {
          // Both published drivers throw on an invalid usage *container* before
          // the Result validator sees it. Preserve the validation path, not a
          // misleading request_failed network error. Never reinterpret other
          // transport exceptions (including cancellation).
          if (error instanceof Error && (error.message === "TypeSafe API invalid usage (response omitted)" ||
              error.message === "Vercel AI Gateway invalid usage (response omitted)")) {
            return reply = { answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, model: input.model };
          }
          throw error;
        }
      },
    };
    const result = await ask({ state, questions, model, signal: signal ?? new AbortController().signal }, { transport });
    if (!result.ok) {
      if (result.code === "request_failed") throw new Error(result.message);
      // Envelope validation cannot be projected to individual judgments.
      // A bad envelope invalidates the call's judgments, not the MCP call.
      if (!isRecord(reply?.answers) || result.code === "invalid_usage" || result.code === "invalid_model" ||
          !Number.isSafeInteger(reply.usage?.input_tokens) || reply.usage.input_tokens < 0 ||
          !Number.isSafeInteger(reply.usage?.output_tokens) || reply.usage.output_tokens < 0 ||
          typeof reply.model !== "string" || !reply.model.trim() ||
          (result.code === "answer_id_mismatch" && Object.keys(reply.answers).some((id) => !Object.hasOwn(questions, id)))) {
        return { answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, provider, model };
      }
      const answers = Object.fromEntries(Object.entries(reply.answers).filter(([id, answer]) =>
        !isRecord(answer) || !Object.hasOwn(answer, "type") || answer.type === (questions[id] as { type?: unknown } | undefined)?.type,
      ));
      // Package rejection is batch-wide; the existing per-tool guards are
      // authoritative for answer validity, including optional score
      // distributions, fractional scores, and valid sibling judgments.
      return { answers, usage: reply.usage, provider, model: reply.model };
    }
    return { answers: result.answer, usage: result.usage, provider, model: result.model };
  }

  if (provider === "openrouter") {
    // OpenRouter has no redirecting "latest" slug; map it to the current
    // release. Pin exact versions with the model env var when that matters.
    const OPENROUTER_LATEST = "jev-1.13";
    const effective = model === "jev-latest" ? OPENROUTER_LATEST : model;
    const slug = effective.startsWith("typesafe/") ? effective : `typesafe/${effective}`;
    const deadline = deadlineSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchWithResilience(apiUrl(process.env.JEV_OPENROUTER_BASE_URL || "https://openrouter.ai/api", "/alpha/decisions"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": REFERER,
          "X-Title": X_TITLE,
          "X-OpenRouter-Title": X_TITLE,
        },
        body: JSON.stringify({ model: slug, state, questions }),
      }, deadline);
      const bodyText = await readBodyBounded(response, deadline);
      if (!response.ok) {
        // Client-visible errors stay fixed-string: provider name and numeric
        // status only, never interpolated upstream response text.
        throw new Error(`OpenRouter decisions API ${response.status}`);
      }
      let body: any;
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Node's parse errors quote the malformed input; a reflecting endpoint
        // must not leak even a snippet through a 200 body.
        throw new Error(`OpenRouter decisions API ${response.status} returned an unparseable response`);
      }
      return {
        answers: body.answers ?? {},
        // The decisions endpoint does not document a usage block; tolerate absence.
        usage: { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 },
        provider,
        model: slug,
      };
    } finally {
      deadline.dispose();
    }
  }

  if (provider === "compatible") {
    const deadline = deadlineSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchWithResilience(process.env.JEV_API_BASE_URL!, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.JEV_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, state, questions }),
      }, deadline);
      const bodyText = await readBodyBounded(response, deadline);
      if (!response.ok) {
        // Client-visible errors stay fixed-string: provider name and numeric
        // status only — a reflecting proxy can echo nothing back through them.
        throw new Error(`Jev-compatible endpoint ${response.status}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = null; // parse failures never retry; surface as invalid response
      }
        const invalid = (why: string) => new Error(`Jev-compatible endpoint returned an invalid response: ${why}`);
        if (!isRecord(body)) throw invalid("expected a JSON object.");
        if (!isRecord(body.answers)) throw invalid("expected an answers object.");
        // Envelope shape is validated here; per-question answer validity is the
        // tools' job. Each tool fails closed under its invalid_response contract,
        // so a missing or malformed answer can never reach tool-level defaults.
        let inputTokens = 0;
        let outputTokens = 0;
        if (body.usage !== undefined && body.usage !== null) {
      const tokenCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
      if (!isRecord(body.usage) || !tokenCount(body.usage.input_tokens) || !tokenCount(body.usage.output_tokens)) {
        throw invalid("usage must report finite non-negative input_tokens and output_tokens.");
      }
      inputTokens = body.usage.input_tokens;
      outputTokens = body.usage.output_tokens;
        }
        if (body.model !== undefined && body.model !== null && typeof body.model !== "string") {
      throw invalid("model must be absent or a string.");
        }
      return {
        answers: body.answers,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        provider,
        model: typeof body.model === "string" ? body.model : model,
      };
    } finally {
      deadline.dispose();
    }
  }

  // Cloudflare Workers AI wraps the same contract in {model, input} and the
  // v4 {result, success} envelope. Single alias; no version pinning.
  const cfSlug = model.startsWith("typesafe/") ? model : `typesafe/${model === "jev-latest" ? "jev" : model}`;
  const cfToken = process.env.JEV_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
  const cfBase = process.env.JEV_CLOUDFLARE_BASE_URL || "https://api.cloudflare.com/client/v4";
  const cfDeadline = deadlineSignal(signal, REQUEST_TIMEOUT_MS);
  let cfBody: Record<string, any>;
  let cfStatus = 0;
  try {
    const cfResponse = await fetchWithResilience(apiUrl(cfBase, `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.JEV_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: cfSlug, input: { state, questions } }),
    }, cfDeadline);
    cfStatus = cfResponse.status;
    const bodyText = await readBodyBounded(cfResponse, cfDeadline);
    cfBody = JSON.parse(cfStatus >= 400 ? redactSecret(bodyText, cfToken) : bodyText);
  } catch (error) {
    if (error instanceof SyntaxError) {
      cfBody = {} as Record<string, any>; // parse failures never retry; surface as invalid response
    } else {
      throw error;
    }
  } finally {
    cfDeadline.dispose();
  }
  // Fixed-string formatter for every Cloudflare error path (HTTP status,
  // success:false, non-Completed state): upstream body and state text never
  // reach MCP-visible error messages, so a reflecting endpoint can echo
  // nothing — not even unredacted — back through them.
  const cfError = () => new Error(`Cloudflare AI run ${cfStatus}${cfStatus < 400 ? " did not complete" : ""}`);
  if (cfStatus >= 400 || cfBody.success === false) {
    throw cfError();
  }
  // The v4 envelope double-nests: body.result.result holds the model output.
  const cfOuter = cfBody.result;
  if (cfOuter && typeof cfOuter.state === "string" && cfOuter.state !== "Completed") {
    throw cfError();
  }
  const cfPayload = cfOuter?.result ?? cfOuter ?? cfBody;
  return {
    answers: cfPayload.answers ?? {},
    usage: { input_tokens: cfPayload.usage?.input_tokens ?? 0, output_tokens: cfPayload.usage?.output_tokens ?? 0 },
    provider,
    model: cfPayload.model ?? cfSlug,
  };
}
