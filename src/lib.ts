// Pure helpers — no API access, fully unit-testable.

/** Max candidates in one jev_find call. TypeSafe Choice supports up to 255 options. */
export const MAX_CANDIDATES = 250;

/** Default per-candidate text cap (characters) to keep request size bounded. */
export const MAX_CANDIDATE_CHARS = 2000;

/**
 * Sanitize a caller-supplied id into a safe Choice option key.
 * Keeps alphanumerics, underscore, dash and dot; collapses the rest.
 */
export function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "";
}

export type Identifiable = { id?: string; [key: string]: unknown };

/** Ensure ids exist, are safe, and are unique; returns the id actually used per candidate. */
export function ensureUniqueIds<T extends Identifiable>(
  items: T[],
  fallbackPrefix: string,
): { items: Array<T & { id: string }>; renamed: Map<string, string> } {
  const used = new Set<string>();
  const renamed = new Map<string, string>();
  const out = items.map((item, i) => {
    const raw = item.id ?? "";
    const base = sanitizeId(raw) || `${fallbackPrefix}${i}`;
    let id = base;
    let n = 1;
    while (used.has(id)) {
      id = `${base}_${n++}`;
    }
    used.add(id);
    if (raw && raw !== id) renamed.set(raw, id);
    return { ...item, id } as T & { id: string };
  });
  return { items: out, renamed };
}

/** Marker appended by `truncate()`; presence means the model saw partial text. */
export const TRUNCATION_MARKER = " […truncated]";

/** Truncate long text with an explicit marker so the model knows it is partial. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_MARKER;
}

/** Unmarked prefix length for coding-loop / review / gate strings sent to Jev.
 *  `truncate()` then appends `TRUNCATION_MARKER`, so the stored string can be longer. */
export const MAX_CODING_LOOP_CHARS = 2000;

/** Max completion claims per jev_gate call; each claim is one extra Choice question. */
export const MAX_GATE_CLAIMS = 16;

export type EvidenceInput =
  | string
  | { id?: string; text: string }
  | Array<{ id?: string; text: string }>;

/** Normalize evidence to `{id,text}` items with unique ids, matching jev_verify. */
export function normalizeEvidence(rawEvidence: EvidenceInput): Array<{ id: string; text: string }> {
  const evidenceItems =
    typeof rawEvidence === "string"
      ? [{ id: "evidence", text: rawEvidence }]
      : Array.isArray(rawEvidence)
        ? rawEvidence
        : [rawEvidence];
  return ensureUniqueIds(evidenceItems, "evidence").items;
}

/** Truncate every string in a coding-loop payload to the unmarked prefix, then the marker. */
export function truncateCodingLoopState<T>(value: T, maxChars = MAX_CODING_LOOP_CHARS): T {
  if (typeof value === "string") return truncate(value, maxChars) as T;
  if (Array.isArray(value)) return value.map((item) => truncateCodingLoopState(item, maxChars)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        truncateCodingLoopState(item, maxChars),
      ]),
    ) as T;
  }
  return value;
}

/** Map a jev_verify relation answer to a verdict label (citation-check cookbook). */
export const RELATION_TO_VERDICT: Record<string, string> = {
  supports: "verified",
  contradicts: "contradicted",
  says_nothing: "unsupported",
};

/** Does this verdict stand on its own, or should a human confirm it? */
export function verifyAction(confidence: number, autoAccept: number): "auto" | "review" {
  return confidence >= autoAccept ? "auto" : "review";
}

/**
 * Screen recommendation from probabilities.
 * injection: probability the text contains instructions aimed at an AI agent.
 * relevance: probability the text is useful for the stated purpose (optional).
 * substance: probability the text has substantive readable content (optional).
 */
export function screenRecommendation(input: {
  injection: number;
  relevance?: number;
  substance?: number;
  blockAt: number;
  reviewAt: number;
}): { action: "pass" | "review" | "block" | "skip"; reason: string } {
  const { injection, relevance, substance, blockAt, reviewAt } = input;
  if (injection >= blockAt)
    return { action: "block", reason: `injection probability ${injection.toFixed(2)} >= block threshold ${blockAt}` };
  if (injection >= reviewAt)
    return { action: "review", reason: `injection probability ${injection.toFixed(2)} >= review threshold ${reviewAt}` };
  if (substance !== undefined && substance < 0.3)
    return { action: "skip", reason: `little substantive content (substance ${substance.toFixed(2)})` };
  if (relevance !== undefined && relevance < 0.3)
    return { action: "skip", reason: `not relevant to the stated purpose (relevance ${relevance.toFixed(2)})` };
  return { action: "pass", reason: "no signals above thresholds" };
}

/** Turn the exists Noul into a document-level verdict (semantic-find cookbook thresholds). */
export function existsVerdict(exists: number, found = 0.7, absent = 0.35): string {
  if (exists >= found) return "answered";
  return exists < absent ? "absent" : "partial";
}

/** Rank candidate ids by Choice probability, descending. Ties keep caller order. */
export function rankCandidates<T extends { id: string }>(
  candidates: T[],
  probabilities: Record<string, number>,
): Array<T & { probability: number }> {
  return candidates
    .map((candidate, index) => ({ candidate: { ...candidate, probability: probabilities[candidate.id] ?? 0 }, index }))
    .sort((a, b) => b.candidate.probability - a.candidate.probability || a.index - b.index)
    .map(({ candidate }) => candidate);
}

/** Max classes per jev_classify call, bounded by the Choice option limit. */
export const MAX_CLASSES = 250;

/** Max items per jev_classify call; each becomes one Choice question in one request. */
export const MAX_ITEMS = 64;

/** Item text cap; classification works on bounded excerpts, not whole documents. */
export const MAX_ITEM_CHARS = 2000;

/** Winner-to-runner-up gap; a lone probability has no runner-up, so its margin is 0. */
export function marginOf(probabilities: Record<string, number> | undefined | null): number {
  const ranked = Object.values(probabilities ?? {}).sort((a, b) => b - a);
  if (ranked.length < 2) return 0;
  return ranked[0] - ranked[1];
}

/**
 * Auto-accept requires BOTH a high top probability and a clear margin, per the
 * conservative thresholds recommended after classification spike testing.
 */
export function classificationDecision(
  topProbability: number,
  margin: number,
  autoAccept: number,
  minimumMargin: number,
): "auto" | "review" {
  return topProbability >= autoAccept && margin >= minimumMargin ? "auto" : "review";
}

/** Max candidates per jev_decide call. */
export const MAX_CANDIDATES_DECIDE = 6;

/** Max requirements per jev_decide call. */
export const MAX_REQUIREMENTS = 3;

/** Escape-hatch options appended to the Choice criteria so the model can decline to rank. */
export const DECIDE_ESCAPE_HATCHES: Record<string, string> = {
  ask_user: "A consequential user preference or requirement is missing; ask instead of inventing it",
  investigate: "Gather missing technical or factual evidence before selecting a candidate",
  none: "None of the supplied candidates fits the known requirements",
};

/**
 * A requirement check contradicts the recommended candidate when it returns
 * "contradicted" for that candidate. Independent questions may disagree with
 * the recommendation; surface the disagreement, do not average it away.
 */
export function contradictsRecommendation(
  checks: Array<{ candidate: string; requirement: number; answer: string }>,
  recommended: string,
): number[] {
  return checks
    .filter((c) => c.candidate === recommended && c.answer === "contradicted")
    .map((c) => c.requirement);
}

// ─────────────────────────────────────────────────────────────────────────────
// Coding-loop policy (question packs + auto / review / escalate)
// Adapted from burnigtm/jev-mcp (MIT). Arithmetic stays in code.
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyAction = "auto" | "review" | "escalate";
export type ClaimVerdict = "verified" | "contradicted" | "unsupported";
export type GateReasonCode =
  | "accepted"
  | "incomplete_context"
  | "review_escalated"
  | "review_required"
  | "claims_contradicted"
  | "claims_unsupported"
  | "claim_confidence_low"
  | "claim_confidence_below_auto_accept";

export const DEFAULT_AUTO_ACCEPT = 0.8;
export const DEFAULT_REVIEW_AT = 0.5;

export const VERIFY_CLAIM_CRITERIA = {
  verified: "The evidence clearly supports the claim",
  contradicted: "The evidence contradicts the claim",
  unsupported: "The evidence neither supports nor contradicts the claim",
} as const;

export const REVIEW_WEIGHTS = {
  correctness: 0.4,
  spec_match: 0.3,
  test_gap: 0.15,
  blast_radius: 0.15,
} as const;

export function validatePolicyThresholds(autoAccept: number, reviewAt: number): void {
  if (
    !Number.isFinite(autoAccept) ||
    !Number.isFinite(reviewAt) ||
    reviewAt < 0 ||
    autoAccept < 0 ||
    autoAccept > 1 ||
    reviewAt > autoAccept
  ) {
    throw new Error("Thresholds must satisfy 0 <= review_at <= auto_accept <= 1.");
  }
}

/** Fill omitted thresholds so a lone low `auto_accept` cannot invert `review_at`. */
export function resolvePolicyThresholds(
  autoAccept = DEFAULT_AUTO_ACCEPT,
  reviewAt?: number,
): { autoAccept: number; reviewAt: number } {
  const resolvedAuto = autoAccept;
  const resolvedReview = reviewAt ?? Math.min(DEFAULT_REVIEW_AT, resolvedAuto);
  validatePolicyThresholds(resolvedAuto, resolvedReview);
  return { autoAccept: resolvedAuto, reviewAt: resolvedReview };
}

/** Incomplete context never returns auto; stronger actions are preserved. */
export function requireCompleteContext(action: PolicyAction, truncated: boolean): PolicyAction {
  return truncated && action === "auto" ? "review" : action;
}

/** True when any string in the payload still carries the truncation marker. */
export function isIncompleteText(value: unknown): boolean {
  if (typeof value === "string") return value.includes(TRUNCATION_MARKER);
  if (Array.isArray(value)) return value.some(isIncompleteText);
  if (value && typeof value === "object") return Object.values(value).some(isIncompleteText);
  return false;
}

function evidenceTexts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(evidenceTexts);
  if (value && typeof value === "object" && "text" in value && typeof (value as { text: unknown }).text === "string") {
    return [(value as { text: string }).text];
  }
  return [];
}

/** True when evidence contains at least one non-whitespace document. */
export function hasNonEmptyEvidence(value: unknown): boolean {
  return evidenceTexts(value).some((text) => text.trim().length > 0);
}

function finite01(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : 0;
}

function finiteScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 0;
}

/** Confidence from a Choice distribution: 1 when certain, 0 when uniform. */
export function confidenceFromProbabilities(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities).filter((p) => Number.isFinite(p) && p >= 0);
  if (values.length < 2) return 0;
  const n = values.length;
  const max = Math.max(...values);
  const uniform = 1 / n;
  if (max <= uniform) return 0;
  return clamp01((max - uniform) / (1 - uniform));
}

export function actionFromConfidence(
  confidence: number,
  autoAccept = DEFAULT_AUTO_ACCEPT,
  reviewAt?: number,
): PolicyAction {
  const thresholds = resolvePolicyThresholds(autoAccept, reviewAt);
  const conf = finite01(confidence);
  if (conf >= thresholds.autoAccept) return "auto";
  if (conf >= thresholds.reviewAt) return "review";
  return "escalate";
}

export function minConfidence(values: Array<number | undefined>): number {
  if (values.length === 0) return 0;
  return Math.min(...values.map((value) => finite01(value)));
}

const CODING_LOOP_NEXT = new Set(["continue", "retry", "ask_user", "stop"]);
const CODING_LOOP_MODEL_TIER = new Set(["cheap", "standard", "reasoning"]);
const CODING_LOOP_FOCUS = new Set(["edit", "search", "test", "read", "plan"]);

function knownChoice(choice: string, allowed: Set<string>): string | null {
  return allowed.has(choice) ? choice : null;
}

export function codingLoopAction(input: {
  nextChoice: string;
  nextConfidence: number;
  riskScore: number;
  doneEnough: number;
  autoAccept?: number;
  reviewAt?: number;
}): PolicyAction {
  const { autoAccept, reviewAt } = resolvePolicyThresholds(input.autoAccept, input.reviewAt);
  const nextConfidence = finite01(input.nextConfidence);
  const riskScore = finiteScore(input.riskScore);
  const doneEnough = finite01(input.doneEnough);
  if (nextConfidence < reviewAt) return "escalate";
  if (!CODING_LOOP_NEXT.has(input.nextChoice)) return "review";
  if (input.nextChoice === "ask_user") return "review";
  if (riskScore >= 1.5) {
    return nextConfidence >= autoAccept ? "review" : "escalate";
  }
  if (input.nextChoice === "stop" && doneEnough < 0.7) return "review";
  if (nextConfidence >= autoAccept && riskScore < 1.2) return "auto";
  return "review";
}

export function projectCodingLoop(
  answers: Record<string, LooseAnswer | undefined>,
  autoAccept: number,
  reviewAt: number,
  incomplete = false,
) {
  const next = asChoiceAnswer(answers.next);
  const modelTier = asChoiceAnswer(answers.model_tier);
  const focus = asChoiceAnswer(answers.focus);
  const risk = asScoreAnswer(answers.risk);
  const doneEnough = asNoulAnswer(answers.done_enough);
  return {
    action: requireCompleteContext(
      codingLoopAction({
        nextChoice: next.choice,
        nextConfidence: next.confidence,
        riskScore: risk.score,
        doneEnough,
        autoAccept,
        reviewAt,
      }),
      incomplete,
    ),
    next: {
      choice: knownChoice(next.choice, CODING_LOOP_NEXT),
      confidence: next.confidence,
      probabilities: next.probabilities,
    },
    model_tier: {
      choice: knownChoice(modelTier.choice, CODING_LOOP_MODEL_TIER),
      confidence: modelTier.confidence,
      probabilities: modelTier.probabilities,
    },
    focus: {
      choice: knownChoice(focus.choice, CODING_LOOP_FOCUS),
      confidence: focus.confidence,
      probabilities: focus.probabilities,
    },
    risk: {
      score: risk.score,
      confidence: risk.confidence,
      legend: risk.legend,
      probabilities: risk.probabilities,
    },
    done_enough: doneEnough,
    needs_more_context: asNoulAnswer(answers.needs_more_context),
    tests_likely_fail: asNoulAnswer(answers.tests_likely_fail),
    thresholds: { auto_accept: autoAccept, review_at: reviewAt },
  };
}

export function reviewAction(input: {
  composite: number;
  safeToApply: number;
  minConfidence: number;
  autoAccept?: number;
  reviewAt?: number;
}): PolicyAction {
  const { autoAccept, reviewAt } = resolvePolicyThresholds(input.autoAccept, input.reviewAt);
  const composite = finite01(input.composite);
  const safeToApply = finite01(input.safeToApply);
  const minConf = finite01(input.minConfidence);
  if (minConf < reviewAt || safeToApply < 0.4) return "escalate";
  if (safeToApply >= autoAccept && composite >= 0.7 && minConf >= autoAccept) {
    return "auto";
  }
  return "review";
}

export function reviewComposite(scores: {
  correctness: number;
  specMatch: number;
  testGap: number;
  blastRadius: number;
}): number {
  const correctness = clamp01(scores.correctness / 2);
  const specMatch = clamp01(scores.specMatch / 2);
  const tests = clamp01(1 - scores.testGap / 2);
  const blast = clamp01(1 - scores.blastRadius / 2);
  return (
    REVIEW_WEIGHTS.correctness * correctness +
    REVIEW_WEIGHTS.spec_match * specMatch +
    REVIEW_WEIGHTS.test_gap * tests +
    REVIEW_WEIGHTS.blast_radius * blast
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function worstAction(actions: PolicyAction[]): PolicyAction {
  if (actions.includes("escalate")) return "escalate";
  if (actions.includes("review")) return "review";
  return "auto";
}

type LooseAnswer = {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  score?: number;
  noul?: number;
  legend?: unknown;
};

function asChoiceAnswer(answer: LooseAnswer | undefined): {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
} {
  return {
    choice: typeof answer?.choice === "string" ? answer.choice : "",
    confidence: finite01(answer?.confidence),
    probabilities: answer?.probabilities ?? {},
  };
}

function asScoreAnswer(answer: LooseAnswer | undefined): {
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend: unknown;
} {
  return {
    score: finiteScore(answer?.score),
    confidence: finite01(answer?.confidence),
    probabilities: answer?.probabilities ?? {},
    legend: answer?.legend ?? null,
  };
}

function asNoulAnswer(answer: LooseAnswer | undefined): number {
  return finite01(answer?.noul);
}

export function projectReview(
  answers: Record<string, LooseAnswer | undefined>,
  autoAccept: number,
  reviewAt: number,
  incomplete = false,
) {
  const correctness = asScoreAnswer(answers.correctness);
  const specMatch = asScoreAnswer(answers.spec_match);
  const testGap = asScoreAnswer(answers.test_gap);
  const blastRadius = asScoreAnswer(answers.blast_radius);
  const safeToApply = asNoulAnswer(answers.safe_to_apply);
  const composite = reviewComposite({
    correctness: correctness.score,
    specMatch: specMatch.score,
    testGap: testGap.score,
    blastRadius: blastRadius.score,
  });
  const action = requireCompleteContext(
    reviewAction({
      composite,
      safeToApply,
      minConfidence: minConfidence([
        correctness.confidence,
        specMatch.confidence,
        testGap.confidence,
        blastRadius.confidence,
      ]),
      autoAccept,
      reviewAt,
    }),
    incomplete,
  );
  return {
    action,
    composite,
    safe_to_apply: safeToApply,
    scores: {
      correctness: { score: correctness.score, confidence: correctness.confidence },
      spec_match: { score: specMatch.score, confidence: specMatch.confidence },
      test_gap: { score: testGap.score, confidence: testGap.confidence },
      blast_radius: { score: blastRadius.score, confidence: blastRadius.confidence },
    },
    weights: { ...REVIEW_WEIGHTS },
    thresholds: { auto_accept: autoAccept, review_at: reviewAt },
  };
}

export function projectClaims(
  answers: Record<string, LooseAnswer | undefined>,
  claims: string[],
  autoAccept: number,
  reviewAt = Math.min(DEFAULT_REVIEW_AT, autoAccept),
  incomplete = false,
) {
  return claims.map((claim, index) => {
    const answer = asChoiceAnswer(answers[`claim_${index}`]);
    const verdict: ClaimVerdict =
      answer.choice === "verified" || answer.choice === "contradicted" || answer.choice === "unsupported"
        ? answer.choice
        : "unsupported";
    let action: PolicyAction = actionFromConfidence(answer.confidence, autoAccept, reviewAt);
    if (answer.confidence < reviewAt || (verdict === "contradicted" && answer.confidence >= autoAccept)) {
      action = "escalate";
    } else if (verdict !== "verified") {
      action = "review";
    }
    return {
      claim,
      verdict,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      action: requireCompleteContext(action, incomplete),
    };
  });
}

export function summarizeClaims(results: Array<{ verdict: ClaimVerdict; action: PolicyAction }>) {
  return {
    verified: results.filter((item) => item.verdict === "verified").length,
    contradicted: results.filter((item) => item.verdict === "contradicted").length,
    unsupported: results.filter((item) => item.verdict === "unsupported").length,
    needs_review: results.filter((item) => item.action !== "auto").length,
  };
}

export function projectGate(
  answers: Record<string, LooseAnswer | undefined>,
  claims: string[],
  autoAccept: number,
  reviewAt: number,
  incomplete = false,
) {
  const review = projectReview(answers, autoAccept, reviewAt, incomplete);
  const results = projectClaims(answers, claims, autoAccept, reviewAt, incomplete);
  const verification = {
    action: worstAction(results.map((item) => item.action)),
    summary: summarizeClaims(results),
    results,
    thresholds: { auto_accept: autoAccept, review_at: reviewAt },
  };
  const action = worstAction([review.action, verification.action]);
  const reason_codes: GateReasonCode[] = [];
  if (incomplete) reason_codes.push("incomplete_context");
  if (review.action === "escalate") reason_codes.push("review_escalated");
  if (review.action === "review") reason_codes.push("review_required");
  if (verification.summary.contradicted > 0) reason_codes.push("claims_contradicted");
  if (verification.summary.unsupported > 0) reason_codes.push("claims_unsupported");
  if (results.some((item) => item.confidence < reviewAt)) reason_codes.push("claim_confidence_low");
  if (results.some((item) => item.confidence >= reviewAt && item.confidence < autoAccept)) {
    reason_codes.push("claim_confidence_below_auto_accept");
  }
  if (action === "auto") reason_codes.push("accepted");
  return { action, reason_codes, review, verification };
}

/** Coding-loop question pack: next step, model tier, focus, risk, completion signals. */
export function codingLoopQuestions(): Record<string, unknown> {
  return {
    next: {
      type: "choice",
      instructions:
        "Given this coding-agent turn, what should happen next? Pick one action. continue = keep going on the current plan. retry = the last step failed and should be retried with a different approach. ask_user = a human decision or missing requirement is blocking. stop = the task is done or cannot usefully continue.",
      criteria: {
        continue: "Keep executing the current plan with the host coding tools",
        retry: "The last edit or command failed; try a different approach",
        ask_user: "Need a human decision, secret, or missing requirement",
        stop: "The task is complete, or further work is not useful",
      },
    },
    model_tier: {
      type: "choice",
      instructions:
        "Which generative-model tier should handle the next coding step? Jev does not write code. cheap = mechanical edits. standard = typical implementation. reasoning = architecture, subtle bugs, or high-stakes design.",
      criteria: {
        cheap: "Rename, format, comments, tiny mechanical edits",
        standard: "Ordinary implementation, tests, or refactors in one area",
        reasoning: "Cross-cutting design, concurrency, security, or unclear root cause",
      },
    },
    risk: {
      type: "score",
      instructions: "How risky is the next action if the host applies it without extra review?",
      criteria: [
        "Read-only or reversible local inspection",
        "Local source edit or test run that stays in the worktree",
        "Destructive, production, force-push, data-loss, or wide blast radius",
      ],
    },
    done_enough: {
      type: "noul",
      instructions: "Is the stated task complete enough to stop?",
      criteria: {
        true: "The request is satisfied and remaining work is polish",
        false: "Important work remains",
      },
    },
    needs_more_context: {
      type: "noul",
      instructions: "Does the host need more files, logs, or user input before a high-quality next step?",
    },
    tests_likely_fail: {
      type: "noul",
      instructions: "If tests were run on the current tree, would they likely fail?",
    },
    focus: {
      type: "choice",
      instructions: "What should the host spend the next step on?",
      criteria: {
        edit: "Change source or config",
        search: "Find the right files or symbols first",
        test: "Run or write tests",
        read: "Read existing code or logs",
        plan: "Think through the approach before editing",
      },
    },
  };
}

/** Patch-review question pack: four 0–2 scores plus safe_to_apply. */
export function reviewQuestions(): Record<string, unknown> {
  return {
    correctness: {
      type: "score",
      instructions: "How likely is this change to be functionally correct for the stated request?",
      criteria: [
        "Clearly wrong or breaks the stated behavior",
        "Uncertain; needs a closer look or tests",
        "Looks correct for the request",
      ],
    },
    spec_match: {
      type: "score",
      instructions: "How well does the change match the user's request, not extra work?",
      criteria: [
        "Misses the request or solves a different problem",
        "Partial match; important pieces missing",
        "Matches the request",
      ],
    },
    test_gap: {
      type: "score",
      instructions: "How large is the test gap for this change?",
      criteria: [
        "Covered or tests are not applicable",
        "Some gaps remain",
        "Likely untested on the risky path",
      ],
    },
    blast_radius: {
      type: "score",
      instructions: "How wide is the blast radius if this lands?",
      criteria: [
        "Tiny local change",
        "Moderate; a few modules",
        "Wide, shared, or production-facing",
      ],
    },
    safe_to_apply: {
      type: "noul",
      instructions: "Is it safe for the host coding agent to apply this change without a human first?",
      criteria: {
        true: "Low-risk and ready",
        false: "Hold for review or more tests",
      },
    },
  };
}

/** One Choice per completion claim; labels are the verdicts themselves. */
export function gateVerifyQuestions(claimCount: number): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (let i = 0; i < claimCount; i += 1) {
    questions[`claim_${i}`] = {
      type: "choice",
      instructions: `Does the evidence support claims[${i}]? Judge only from the provided evidence, not world knowledge.`,
      criteria: { ...VERIFY_CLAIM_CRITERIA },
    };
  }
  return questions;
}

/** Combined review + evidence-only claim questions for one upstream call. */
export function gateQuestions(claimCount: number): Record<string, unknown> {
  const review = reviewQuestions();
  for (const question of Object.values(review) as Array<{ instructions?: unknown }>) {
    question.instructions = `${question.instructions} Assess the proposed diff against request, using tests as reported test output. Claims are assertions to check, not evidence that the patch is correct or tested.`;
  }
  const verification = gateVerifyQuestions(claimCount);
  for (const question of Object.values(verification) as Array<{ instructions?: unknown }>) {
    question.instructions = `${question.instructions} Use only the evidence field as factual support. Request and claims are assertions, not evidence; diff and tests belong to the separate patch review. If a claim needs a diff or test log as support, it must be supplied in evidence.`;
  }
  return { ...review, ...verification };
}
