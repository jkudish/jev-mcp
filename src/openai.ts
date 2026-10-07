// OpenAI Decisions has a different wire contract from Jev's System One API.
// Keep translation here; the existing tools still validate each judgment.
import { createHash } from "node:crypto";
import { isRecord } from "./lib.js";

export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
export const MAX_DECISION_IMAGES = 8;
export const MAX_DECISION_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_DECISION_IMAGES_BYTES = 8 * 1024 * 1024;
export const MAX_DECISION_IMAGE_URL_CHARS = 4 * Math.ceil(MAX_DECISION_IMAGE_BYTES / 3) + 64;

export interface DecisionImage {
  id: string;
  data_url: string;
}

/** Validate inline images without fetching URLs or reading local paths. */
export function decisionImageMetadata(images: readonly DecisionImage[]) {
  if (images.length > MAX_DECISION_IMAGES) throw new Error("Too many decision images.");
  const seen = new Set<string>();
  let total = 0;
  return images.map((image) => {
    if (seen.has(image.id)) throw new Error("Duplicate decision image id.");
    seen.add(image.id);
    const comma = image.data_url.indexOf(",");
    const header = image.data_url.slice(0, comma);
    const mime = header.match(/^data:(image\/(?:png|jpeg|webp|gif));base64$/)?.[1];
    const encoded = image.data_url.slice(comma + 1);
    // Buffer's decoder tolerates malformed base64; a round trip makes the
    // accepted form explicit and excludes whitespace, junk, and URL-safe data.
    if (!mime || !encoded || image.data_url.length > MAX_DECISION_IMAGE_URL_CHARS ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error("Decision images must be inline base64 PNG, JPEG, WebP, or GIF data URLs.");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length > MAX_DECISION_IMAGE_BYTES) {
      throw new Error("Decision image has invalid base64 or exceeds the 4 MiB image limit.");
    }
    total += bytes.length;
    if (total > MAX_DECISION_IMAGES_BYTES) throw new Error("Decision images exceed the 8 MiB total limit.");
    return { id: image.id, mime_type: mime, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

const instructionText = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);

/** Jev noul/choice/score -> OpenAI predicate/choice/score, preserving names. */
export function openAIQuestions(questions: Record<string, unknown>) {
  return Object.entries(questions).map(([name, question]) => {
    const invalid = () => new Error("Cannot translate an invalid question to OpenAI Decisions.");
    if (!isRecord(question)) throw invalid();
    const instructions = instructionText(question.instructions);
    if (question.type === "noul") {
      const criteria = isRecord(question.criteria) ? question.criteria : {};
      const outcomes = ["true", "false"].flatMap((key) =>
        typeof criteria[key] === "string" ? [`${key}: ${criteria[key]}`] : [],
      );
      return { type: "predicate", name, instructions: [instructions, ...outcomes].join("\n") };
    }
    if (question.type === "choice" && isRecord(question.criteria)) {
      return {
        type: "choice", name, instructions,
        choices: Object.entries(question.criteria).map(([value, description]) => ({
          value,
          ...(typeof description === "string" ? { description } : {}),
        })),
      };
    }
    if (question.type === "score" && Array.isArray(question.criteria)) {
      return {
        type: "score", name, instructions,
        levels: question.criteria.map((description, index) => ({
          label: String(index),
          ...(typeof description === "string" ? { description } : {}),
        })),
      };
    }
    throw invalid();
  });
}

/** Images are ordered and labelled; base64 is never embedded in the text state. */
export function openAIInput(state: unknown, images: readonly DecisionImage[]) {
  const evidence = typeof state === "string" ? state : JSON.stringify(state);
  if (images.length === 0) return evidence;
  return [{
    role: "user",
    content: [
      { type: "input_text", text: evidence },
      ...images.flatMap((image) => [
        { type: "input_text", text: `Evidence image: ${image.id}` },
        { type: "input_image", image_url: image.data_url },
      ]),
    ],
  }];
}

// Choice values are strings; score values are numeric indices. Reject
// duplicate values before converting an array to a record, which would hide
// duplicates and could turn a malformed distribution into a valid one.
function probabilities(value: unknown, expected: string[], score: boolean): Record<string, number> | null {
  if (!Array.isArray(value) || value.length !== expected.length) return null;
  const entries: Array<[string, number]> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || (score ? !Number.isInteger(entry.value) : typeof entry.value !== "string")) return null;
    const key = String(entry.value);
    if (!expected.includes(key) || seen.has(key) || typeof entry.probability !== "number" ||
        !Number.isFinite(entry.probability) || entry.probability < 0 || entry.probability > 1) return null;
    seen.add(key);
    entries.push([key, entry.probability]);
  }
  return Object.fromEntries(entries);
}

/** Adapt named answers without mistaking refusals or malformed siblings for success. */
export function openAIReply(body: unknown, questions: Record<string, unknown>) {
  const invalid = () => new Error("OpenAI decisions API returned an invalid response.");
  if (!isRecord(body) || !Array.isArray(body.answers) || !isRecord(body.usage) ||
      !Number.isSafeInteger(body.usage.input_tokens) || (body.usage.input_tokens as number) < 0 ||
      !Number.isSafeInteger(body.usage.output_tokens) || (body.usage.output_tokens as number) < 0 ||
      typeof body.model !== "string" || !body.model.trim()) throw invalid();
  const answers: Record<string, unknown> = Object.create(null);
  const seen = new Set<string>();
  for (const answer of body.answers) {
    if (!isRecord(answer) || typeof answer.name !== "string" || !Object.hasOwn(questions, answer.name)) throw invalid();
    const name = answer.name;
    if (seen.has(name)) {
      delete answers[name]; // an ambiguous name invalidates only that judgment
      continue;
    }
    seen.add(name);
    const question = questions[name] as Record<string, unknown>;
    if (answer.type === "predicate" && question.type === "noul") {
      answers[name] = { noul: answer.probability };
    } else if (answer.type === "choice" && question.type === "choice" && isRecord(question.criteria)) {
      const distribution = probabilities(answer.probabilities, Object.keys(question.criteria), false);
      if (distribution) answers[name] = { choice: answer.choice, probabilities: distribution, confidence: answer.confidence };
    } else if (answer.type === "score" && question.type === "score" && Array.isArray(question.criteria)) {
      const distribution = probabilities(answer.probabilities, question.criteria.map((_, i) => String(i)), true);
      if (distribution) answers[name] = { score: answer.score, probabilities: distribution, confidence: answer.confidence };
    }
    // A refusal or type mismatch leaves a missing answer, so each tool takes
    // its existing invalid_response path. No refusal text reaches the caller.
  }
  return {
    answers,
    model: body.model,
    usage: { input_tokens: body.usage.input_tokens as number, output_tokens: body.usage.output_tokens as number },
  };
}
