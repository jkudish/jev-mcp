// Jev transport: TypeSafe direct (default), OpenRouter Decisions, Cloudflare
// Workers AI, or a caller-supplied Jev-compatible System One endpoint. All
// speak the {state, questions} / answers contract; URL, auth, and model slugs
// differ. Proxies add hops, so direct TypeSafe remains the recommended default.

import { experimental_evaluate } from "ai";
import { TypeSafeClient } from "@typesafe-ai/sdk";

export type JevProvider = "typesafe" | "openrouter" | "cloudflare" | "vercel" | "compatible";

export interface AskResult {
  answers: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number };
  provider: JevProvider;
  model: string;
}

const X_TITLE = "jev-mcp";
const REFERER = "https://github.com/jkudish/jev-mcp";

// A JSON object on the wire: present, non-null, and not an array.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Replace every occurrence of the secret so a reflecting endpoint cannot leak
// it into MCP-visible error text; covering the bare form also covers the
// "Bearer <secret>" form.
function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

// Boundary check of every requested question's answer for the compatible
// provider: present as an own property and primitive-valid for its question
// type, mirroring the invalid_response contract the tools enforce on model
// output. Returns the first problem found, or null.
function findInvalidAnswer(questions: Record<string, unknown>, answers: Record<string, unknown>): string | null {
  for (const [id, question] of Object.entries(questions)) {
    if (!Object.hasOwn(answers, id)) return `no answer for question "${id}".`;
    const q = question as { type?: unknown; criteria?: unknown } | null;
    const answer = answers[id];
    if (!isRecord(answer)) return `the answer for "${id}" must be an object.`;
    if (q?.type === "noul") {
      const noul = answer.noul;
      if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
        return `the answer for "${id}" must report a finite noul probability in [0,1].`;
      }
    } else if (q?.type === "choice") {
      const criteria = q.criteria;
      const choice = answer.choice;
      if (typeof choice !== "string" || !isRecord(criteria) || !Object.hasOwn(criteria, choice)) {
        return `the answer for "${id}" must choose one of its question's criteria.`;
      }
    } else if (q?.type === "score") {
      const criteria = q.criteria;
      const score = answer.score;
      const max = Array.isArray(criteria) ? criteria.length - 1 : -1;
      if (max < 0 || typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > max) {
        return `the answer for "${id}" must report a finite score within its rubric.`;
      }
    }
  }
  return null;
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
      adapted[id] = { type: "choice", choice: answer.choice, probabilities: answer.probabilities ?? {}, confidence: confidence[id] ?? null };
    } else if (answer?.type === "score") {
      adapted[id] = { type: "score", score: answer.score, probabilities: answer.probabilities ?? {}, confidence: confidence[id] ?? null };
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
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": REFERER,
        "X-Title": X_TITLE,
        "X-OpenRouter-Title": X_TITLE,
      },
      body: JSON.stringify({ model: slug, state, questions }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenRouter decisions API ${response.status}: ${body.slice(0, 200)}`);
    }
    const body = await response.json();
    return {
      answers: body.answers ?? {},
      // The decisions endpoint does not document a usage block; tolerate absence.
      usage: { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 },
      provider,
      model: slug,
    };
  }

  if (provider === "compatible") {
    const response = await fetch(process.env.JEV_API_BASE_URL!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.JEV_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, state, questions }),
      signal,
    });
    if (!response.ok) {
      const apiKey = process.env.JEV_API_KEY ?? "";
      // Redact the key before the body becomes MCP-visible error text; a
      // proxy that reflects the request would otherwise echo it back.
      const body = redactSecret(await response.text().catch(() => ""), apiKey).slice(0, 200);
      throw new Error(`Jev-compatible endpoint ${response.status}: ${body}`);
    }
    const body = await response.json().catch(() => null);
    const invalid = (why: string) => new Error(`Jev-compatible endpoint returned an invalid response: ${why}`);
    if (!isRecord(body)) throw invalid("expected a JSON object.");
    if (!isRecord(body.answers)) throw invalid("expected an answers object.");
    // Validate at the boundary so a garbage endpoint cannot reach tool-level
    // defaults: a missing injection answer, for instance, would otherwise
    // screen as a clean pass.
    const invalidAnswer = findInvalidAnswer(questions, body.answers);
    if (invalidAnswer !== null) throw invalid(invalidAnswer);
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
  const cfResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.JEV_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: cfSlug, input: { state, questions } }),
      signal,
    },
  );
  const cfBody = await cfResponse.json().catch(() => ({}));
  if (!cfResponse.ok || cfBody.success === false) {
    throw new Error(`Cloudflare AI run ${cfResponse.status}: ${JSON.stringify(cfBody.errors ?? cfBody).slice(0, 200)}`);
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
