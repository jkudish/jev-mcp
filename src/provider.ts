// Jev transport: TypeSafe direct (default), OpenRouter Decisions, Cloudflare
// Workers AI, or a caller-supplied Jev-compatible System One endpoint. All
// speak the {state, questions} / answers contract; URL, auth, and model slugs
// differ. Proxies add hops, so direct TypeSafe remains the recommended default.

import { experimental_evaluate } from "ai";
import { TypeSafeClient } from "@typesafe-ai/sdk";
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

/** Only statuses that mean the request was not processed are retried. */
const isRetryableStatus = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Jittered exponential backoff: 50-100% of the doubling delay, capped. */
function retryDelayMs(attempt: number): number {
  const exp = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
  return exp * (0.5 + Math.random() * 0.5);
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
  try {
    for (;;) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(deadline.timedOut() ? new Error(`Jev request exceeded the ${REQUEST_TIMEOUT_MS}ms deadline while reading the response.`) : deadline.signal.reason);
          if (deadline.signal.aborted) onAbort();
          else deadline.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes after reading ${total}; aborting the read.`);
      }
      chunks.push(value);
    }
  } finally {
    // On the success path the reader is already done; on throw this releases
    // the connection instead of leaking it.
    await reader.cancel().catch(() => {});
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
 * Fetch with bounded, jittered retries on 408/409/429/5xx only. Aborts
 * (caller cancellation), deadline expiry, oversized bodies, parse failures,
 * and non-retryable statuses are surfaced immediately, never re-sent: a
 * retry only happens when the status says the request was not processed.
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
      if (deadline.signal.aborted) throw error; // caller cancelled: never retry
      if (attempt >= MAX_ATTEMPTS) throw error;
      await sleep(retryDelayMs(attempt));
      continue;
    }
    if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
      // Drain and release the connection before backing off.
      await response.body?.cancel().catch(() => {});
      await sleep(retryDelayMs(attempt));
      continue;
    }
    return response;
  }
}

let typesafeClient: TypeSafeClient | null = null;

function resolve(env: NodeJS.ProcessEnv): JevProvider {
  const explicit = (env.JEV_PROVIDER ?? "auto").toLowerCase();
  const hasTypesafe = Boolean(env.TYPESAFE_API_KEY);
  const hasOpenRouter = /^sk-or-/.test(env.OPENROUTER_API_KEY ?? "");
  const cfToken = env.JEV_CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const hasCloudflare = Boolean(cfToken && env.CLOUDFLARE_ACCOUNT_ID);
  const hasCompatible = Boolean(env.JEV_API_KEY && env.JEV_API_BASE_URL);

  if (explicit === "typesafe") {
    if (!hasTypesafe) throw new Error("JEV_PROVIDER=typesafe but TYPESAFE_API_KEY is not set.");
    return "typesafe";
  }
  if (explicit === "openrouter") {
    if (!hasOpenRouter) throw new Error("JEV_PROVIDER=openrouter but OPENROUTER_API_KEY is not set or not an sk-or- key.");
    return "openrouter";
  }
  if (explicit === "vercel") {
    if (!env.AI_GATEWAY_API_KEY) throw new Error("JEV_PROVIDER=vercel but AI_GATEWAY_API_KEY is not set.");
    return "vercel";
  }
  if (explicit === "cloudflare") {
    if (!hasCloudflare) throw new Error("JEV_PROVIDER=cloudflare but a Cloudflare API token (CLOUDFLARE_API_TOKEN or JEV_CLOUDFLARE_API_TOKEN) and CLOUDFLARE_ACCOUNT_ID are not both set.");
    return "cloudflare";
  }
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
  if (hasTypesafe) return "typesafe";
  if (hasOpenRouter) return "openrouter";
  if (hasCloudflare) return "cloudflare";
  if (env.AI_GATEWAY_API_KEY) return "vercel";
  if (hasCompatible) return "compatible";
  throw new Error(
    "No Jev provider credentials found. Set TYPESAFE_API_KEY, OPENROUTER_API_KEY (sk-or-), Cloudflare token + CLOUDFLARE_ACCOUNT_ID, AI_GATEWAY_API_KEY, or JEV_API_KEY + JEV_API_BASE_URL; set JEV_PROVIDER to choose explicitly.",
  );
}

// Normalize the AI SDK evaluate envelope without making a provider request.
export function adaptVercelAnswers(result: {
  answers?: Record<string, any> | null;
  providerMetadata?: Record<string, any> | null;
}): Record<string, any> {
  const confidence = (result.providerMetadata?.typesafe?.confidence ?? {}) as Record<string, number>;
  const adapted: Record<string, any> = {};
  for (const [id, answer] of Object.entries((result.answers ?? {}) as Record<string, any>)) {
    if (answer?.type === "boolean") {
      adapted[id] = { type: "noul", noul: answer.probability };
    } else if (answer?.type === "choice") {
      // A distribution the upstream answer did not carry stays absent rather
      // than becoming {}: score tools treat an absent distribution as "not
      // reported" (still valid) and a present-but-malformed one as invalid;
      // choice tools require a distribution, so absence and {} both fail
      // their validation identically either way.
      adapted[id] = answer.probabilities != null
        ? { type: "choice", choice: answer.choice, probabilities: answer.probabilities, confidence: confidence[id] ?? null }
        : { type: "choice", choice: answer.choice, confidence: confidence[id] ?? null };
    } else if (answer?.type === "score") {
      adapted[id] = answer.probabilities != null
        ? { type: "score", score: answer.score, probabilities: answer.probabilities, confidence: confidence[id] ?? null }
        : { type: "score", score: answer.score, confidence: confidence[id] ?? null };
    } else {
      adapted[id] = answer;
    }
  }
  return adapted;
}

export async function askJev(
  state: unknown,
  questions: Record<string, unknown>,
  model: string,
  signal?: AbortSignal,
): Promise<AskResult> {
  const provider = resolve(process.env);

  if (provider === "typesafe") {
    typesafeClient ??= new TypeSafeClient(
      process.env.TYPESAFE_BASE_URL ? { baseURL: process.env.TYPESAFE_BASE_URL } : undefined,
    );
    const response = await (
      typesafeClient.systemOne as unknown as (
        payload: { state: unknown; questions: Record<string, unknown>; model?: string },
        options?: { signal?: AbortSignal },
      ) => Promise<any>
    )({ state, questions, model }, { signal });
    return {
      answers: response.answers,
      usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 },
      provider,
      model,
    };
  }

  if (provider === "openrouter") {
    // OpenRouter has no redirecting "latest" slug; map it to the current
    // release. Pin exact versions with the model env var when that matters.
    const OPENROUTER_LATEST = "jev-1.13";
    const effective = model === "jev-latest" ? OPENROUTER_LATEST : model;
    const slug = effective.startsWith("typesafe/") ? effective : `typesafe/${effective}`;
    const deadline = deadlineSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchWithResilience("https://openrouter.ai/api/alpha/decisions", {
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
        // Redact the key before the body becomes MCP-visible error text.
        const body = redactSecret(bodyText, process.env.OPENROUTER_API_KEY ?? "").slice(0, 200);
        throw new Error(`OpenRouter decisions API ${response.status}: ${body}`);
      }
      const body = JSON.parse(bodyText);
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
        const apiKey = process.env.JEV_API_KEY ?? "";
        // Redact the key before the body becomes MCP-visible error text; a
        // proxy that reflects the request would otherwise echo it back.
        const body = redactSecret(bodyText, apiKey).slice(0, 200);
        throw new Error(`Jev-compatible endpoint ${response.status}: ${body}`);
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

  if (provider === "vercel") {
  // Vercel AI Gateway exposes Jev through the AI SDK's experimental evaluate
  // API: "noul" questions become "boolean", answers return as probabilities,
  // and Choice/Score confidence lives in providerMetadata.typesafe.
  const vercelQuestions: Record<string, any> = {};
  for (const [id, question] of Object.entries(questions)) {
    const q = question as { type: string; instructions?: unknown; criteria?: unknown };
    vercelQuestions[id] = {
      type: q.type === "noul" ? "boolean" : q.type,
      instructions: q.instructions,
      criteria: q.criteria,
    };
  }
  const result = await experimental_evaluate({
    model: model.startsWith("typesafe-ai/") ? model : "typesafe-ai/jev",
    state: state as any,
    questions: vercelQuestions as any,
    abortSignal: signal,
  });
  return {
    answers: adaptVercelAnswers(result),
    usage: { input_tokens: result.usage?.inputTokens ?? 0, output_tokens: result.usage?.outputTokens ?? 0 },
    provider,
    model: "typesafe-ai/jev",
  };
}

  // Cloudflare Workers AI wraps the same contract in {model, input} and the
  // v4 {result, success} envelope. Single alias; no version pinning.
  const cfSlug = model.startsWith("typesafe/") ? model : `typesafe/${model === "jev-latest" ? "jev" : model}`;
  const cfDeadline = deadlineSignal(signal, REQUEST_TIMEOUT_MS);
  let cfBody: Record<string, any>;
  let cfStatus = 0;
  try {
    const cfResponse = await fetchWithResilience(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.JEV_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: cfSlug, input: { state, questions } }),
      },
      cfDeadline,
    );
    cfStatus = cfResponse.status;
    // Redact the token before the body becomes MCP-visible error text; a
    // reflecting endpoint would otherwise echo it back (error paths only, so
    // legitimate answer values are never rewritten).
    const cfToken = process.env.JEV_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
    cfBody = JSON.parse(cfStatus >= 400 ? redactSecret(await readBodyBounded(cfResponse, cfDeadline), cfToken) : await readBodyBounded(cfResponse, cfDeadline));
  } catch (error) {
    if (error instanceof SyntaxError) {
      cfBody = {} as Record<string, any>; // parse failures never retry; surface as invalid response
    } else {
      throw error;
    }
  } finally {
    cfDeadline.dispose();
  }
  const cfToken = process.env.JEV_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
  if (cfStatus >= 400 || cfBody.success === false) {
    throw new Error(`Cloudflare AI run ${cfStatus}: ${redactSecret(JSON.stringify(cfBody.errors ?? cfBody), cfToken).slice(0, 200)}`);
  }
  // The v4 envelope double-nests: body.result.result holds the model output.
  const cfOuter = cfBody.result;
  if (cfOuter && typeof cfOuter.state === "string" && cfOuter.state !== "Completed") {
    throw new Error(`Cloudflare AI run state ${cfOuter.state}: ${JSON.stringify(cfBody.errors ?? []).slice(0, 200)}`);
  }
  const cfPayload = cfOuter?.result ?? cfOuter ?? cfBody;
  return {
    answers: cfPayload.answers ?? {},
    usage: { input_tokens: cfPayload.usage?.input_tokens ?? 0, output_tokens: cfPayload.usage?.output_tokens ?? 0 },
    provider,
    model: cfPayload.model ?? cfSlug,
  };
}
