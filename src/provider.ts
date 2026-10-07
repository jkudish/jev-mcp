// Every judgment goes through @jkudish/discern-agent-tools, which owns the
// carriers (TypeSafe Jev, OpenRouter, Cloudflare Workers AI including Clef,
// Vercel AI Gateway, a System One-compatible endpoint, and OpenAI Decisions),
// their retries, the whole-request deadline, the response-size ceiling, and
// fixed-string errors. This module adds only what MCP needs on top: its two
// resilience settings, and per-judgment validation, so one bad answer
// invalidates that judgment rather than the whole call.

import { ask, resolveTransport, type DiscernTransportReply } from "@jkudish/discern-agent-tools";
import { discernEnv } from "./env.js";
import { isRecord } from "./lib.js";

export type DiscernProvider = "typesafe" | "openrouter" | "cloudflare" | "vercel" | "openai" | "compatible";

export interface AskResult {
  answers: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number };
  provider: DiscernProvider;
  model: string;
}

const positiveInt = (value: string | undefined): number | undefined => {
  const raw = Number(value);
  return Number.isInteger(raw) && raw > 0 ? raw : undefined;
};

const TRANSPORT_FAILURES = new Set(["request_failed", "rate_limited", "unavailable", "timeout", "configuration_error"]);

export async function askDiscern(
  state: unknown,
  questions: Record<string, unknown>,
  model: string,
  signal?: AbortSignal,
): Promise<AskResult> {
  const env = discernEnv();
  // Whole-request deadline (all attempts) and total attempts, overridable for tests and tight hosts.
  const timeoutMs = positiveInt(env.DISCERN_MCP_REQUEST_TIMEOUT_MS);
  const maxAttempts = positiveInt(env.DISCERN_MCP_MAX_ATTEMPTS);
  // Keep the raw reply: the shared validator rejects a whole batch when one
  // answer is invalid, but MCP reports each judgment on its own.
  let reply: DiscernTransportReply | undefined;
  const result = await ask(
    { state, questions, model, signal: signal ?? new AbortController().signal },
    { env, timeoutMs, maxAttempts, onReply: (raw) => { reply = raw; } },
  );
  if (result.ok) return { answers: result.answer, usage: result.usage, provider: result.provider as DiscernProvider, model: result.model };
  if (TRANSPORT_FAILURES.has(result.code)) throw new Error(result.message);
  // A reply reached validation, so selection succeeded; name the carrier that
  // answered and report the model it answered with whenever that is usable.
  const provider = resolveTransport(env).name as DiscernProvider;
  const answeredModel = typeof reply?.model === "string" && reply.model.trim() ? reply.model : model;
  // Envelope validation cannot be projected to individual judgments: a bad
  // envelope invalidates the call's judgments, not the MCP call.
  if (!isRecord(reply?.answers) || result.code === "invalid_usage" || result.code === "invalid_model" ||
      !Number.isSafeInteger(reply.usage?.input_tokens) || reply.usage.input_tokens < 0 ||
      !Number.isSafeInteger(reply.usage?.output_tokens) || reply.usage.output_tokens < 0 ||
      typeof reply.model !== "string" || !reply.model.trim() ||
      (result.code === "answer_id_mismatch" && Object.keys(reply.answers).some((id) => !Object.hasOwn(questions, id)))) {
    return { answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, provider, model: answeredModel };
  }
  // The package's rejection is batch-wide; each tool's own guards decide which
  // judgments are valid. Answers of the wrong type (including refusals) are
  // dropped, so they read as missing and fail closed as invalid_response.
  const answers = Object.fromEntries(Object.entries(reply.answers).filter(([id, answer]) =>
    !isRecord(answer) || !Object.hasOwn(answer, "type") || answer.type === (questions[id] as { type?: unknown } | undefined)?.type,
  ));
  return { answers, usage: reply.usage, provider, model: reply.model };
}
