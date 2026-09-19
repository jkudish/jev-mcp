import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimAction,
  classificationDecision,
  contradictsRecommendation,
  DECIDE_ESCAPE_HATCHES,
  ensureUniqueIds,
  existsVerdict,
  marginOf,
  MAX_CANDIDATES,
  MAX_CANDIDATES_DECIDE,
  MAX_CLAIM_CHARS,
  MAX_GATE_CLAIMS,
  MAX_REVIEW_DOC_CHARS,
  MAX_CLASSES,
  MAX_ITEM_CHARS,
  MAX_ITEMS,
  MAX_REQUIREMENTS,
  rankCandidates,
  RELATION_TO_VERDICT,
  requireCompleteContext,
  resolvePolicyThresholds,
  reviewAction,
  reviewComposite,
  worstAction,
  normalizeEvidence,
  hasNonEmptyEvidence,
  sanitizeId,
  screenRecommendation,
  truncate,
  verifyAction,
} from "../dist/lib.js";

test("sanitizeId keeps safe characters and drops the rest", () => {
  assert.equal(sanitizeId("src/lib.ts"), "src_lib.ts");
  assert.equal(sanitizeId("note: hello?!"), "note_hello");
  assert.equal(sanitizeId("???"), "");
  assert.equal(sanitizeId("a".repeat(100)).length, 64);
});

test("ensureUniqueIds assigns fallbacks and resolves collisions", () => {
  const { items, renamed } = ensureUniqueIds(
    [
      { id: "src/lib.ts", text: "a" },
      { id: "src/lib.ts", text: "b" },
      { text: "c" },
    ],
    "candidate",
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ["src_lib.ts", "src_lib.ts_1", "candidate2"],
  );
  assert.equal(renamed.size, 1);
});

test("truncate marks truncated text", () => {
  const out = truncate("abcdef", 3);
  assert.equal(out.length > 3, true);
  assert.match(out, /…truncated\]$/);
  assert.equal(truncate("abc", 3), "abc");
});

test("relation maps to verdict labels", () => {
  assert.equal(RELATION_TO_VERDICT.supports, "verified");
  assert.equal(RELATION_TO_VERDICT.contradicts, "contradicted");
  assert.equal(RELATION_TO_VERDICT.says_nothing, "unsupported");
  assert.equal(RELATION_TO_VERDICT.other, undefined);
});

test("verifyAction gates on auto-accept threshold", () => {
  assert.equal(verifyAction(0.8, 0.8), "auto");
  assert.equal(verifyAction(0.79, 0.8), "review");
  assert.equal(verifyAction(0.99, 0.8), "auto");
});

test("screenRecommendation escalates by injection then demotes junk", () => {
  assert.deepEqual(screenRecommendation({ injection: 0.9, blockAt: 0.75, reviewAt: 0.25 }).action, "block");
  assert.deepEqual(screenRecommendation({ injection: 0.4, blockAt: 0.75, reviewAt: 0.25 }).action, "review");
  assert.deepEqual(screenRecommendation({ injection: 0.01, blockAt: 0.75, reviewAt: 0.25 }).action, "pass");
  assert.deepEqual(
    screenRecommendation({ injection: 0.01, substance: 0.1, blockAt: 0.75, reviewAt: 0.25 }).action,
    "skip",
  );
  assert.deepEqual(
    screenRecommendation({ injection: 0.01, relevance: 0.05, blockAt: 0.75, reviewAt: 0.25 }).action,
    "skip",
  );
});

test("existsVerdict uses cookbook thresholds", () => {
  assert.equal(existsVerdict(0.98), "answered");
  assert.equal(existsVerdict(0.46), "partial");
  assert.equal(existsVerdict(0.14), "absent");
});

test("rankCandidates orders by probability and keeps caller order on ties", () => {
  const candidates = [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "3" }];
  const ranked = rankCandidates(candidates, { a: 0.1, b: 0.5, c: 0.1 });
  assert.deepEqual(
    ranked.map((c) => c.id),
    ["b", "a", "c"],
  );
  const missing = rankCandidates([{ id: "x", text: "1" }], {});
  assert.equal(missing[0].probability, 0);
});

test("MAX_CANDIDATES stays within TypeSafe Choice option limit", () => {
  assert.ok(MAX_CANDIDATES <= 255);
});



test("marginOf measures winner-to-runner-up gap", () => {
  assert.ok(Math.abs(marginOf({ a: 0.7, b: 0.2, c: 0.1 }) - 0.5) < 1e-9);
  assert.equal(marginOf({ a: 0.5, b: 0.5 }), 0);
  assert.equal(marginOf({ only: 0.8 }), 0); // lone probability: no runner-up, margin 0
  assert.equal(marginOf(undefined), 0);
  assert.equal(marginOf(null), 0);
});

test("classificationDecision requires both top probability and margin", () => {
  assert.equal(classificationDecision(0.9, 0.6, 0.85, 0.5), "auto");
  assert.equal(classificationDecision(0.9, 0.4, 0.85, 0.5), "review"); // high conf, thin margin
  assert.equal(classificationDecision(0.8, 0.8, 0.85, 0.5), "review"); // wide margin, low top
  assert.equal(classificationDecision(0.85, 0.5, 0.85, 0.5), "auto"); // exactly at both gates
});

test("catalog and batch caps stay within Jev limits", () => {
  assert.ok(MAX_CLASSES <= 255);
  assert.ok(MAX_ITEMS >= 2 && MAX_ITEMS <= 255);
});

test("contradictsRecommendation flags only the recommended candidate", () => {
  const checks = [
    { candidate: "a", requirement: 0, answer: "contradicted" },
    { candidate: "a", requirement: 1, answer: "supported" },
    { candidate: "b", requirement: 0, answer: "contradicted" },
    { candidate: "a", requirement: 2, answer: "unknown" },
  ];
  assert.deepEqual(contradictsRecommendation(checks, "a"), [0]);
  assert.deepEqual(contradictsRecommendation(checks, "b"), [0]); // b also contradicts req 0
  assert.deepEqual(contradictsRecommendation([], "a"), []);
});

test("decide caps stay sane", () => {
  assert.ok(MAX_CANDIDATES_DECIDE >= 2 && MAX_CANDIDATES_DECIDE <= 10);
  assert.ok(MAX_REQUIREMENTS >= 0 && MAX_REQUIREMENTS <= 10);
  assert.ok(Object.keys(DECIDE_ESCAPE_HATCHES).length === 3);
});

// jev_rerank / jev_compare / jev_extract helpers
import {
  ASPECT_RELATIONS,
  COMPARE_RELATIONS,
  MAX_COMPARE_ASPECTS,
  MAX_EXTRACT_CANDIDATE_CHARS,
  MAX_EXTRACT_CANDIDATES,
  MAX_EXTRACT_FIELDS,
  MAX_RERANK_CANDIDATES,
  MAX_RERANK_TOTAL_CHARS,
  rerankByScore,
} from "../dist/lib.js";

test("rerankByScore sorts by index-aligned relevance descending", () => {
  const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const ranked = rerankByScore(candidates, [0.2, 0.9, 0.5]);
  assert.deepEqual(ranked.map((c) => c.id), ["b", "c", "a"]);
  assert.equal(ranked[0].relevance, 0.9);
  // ties keep original order (stable sort)
  const tied = rerankByScore(candidates, [0.5, 0.5, 0.5]);
  assert.deepEqual(tied.map((c) => c.id), ["a", "b", "c"]);
});

test("rerank/compare/extract caps stay sane", () => {
  assert.ok(MAX_RERANK_CANDIDATES >= 2 && MAX_RERANK_CANDIDATES <= 250);
  assert.ok(MAX_RERANK_TOTAL_CHARS >= 10_000 && MAX_RERANK_TOTAL_CHARS <= 250_000);
  assert.ok(MAX_COMPARE_ASPECTS >= 1 && MAX_COMPARE_ASPECTS <= 20);
  assert.ok(MAX_EXTRACT_FIELDS >= 1 && MAX_EXTRACT_FIELDS <= 64);
  assert.ok(MAX_EXTRACT_CANDIDATES >= 2 && MAX_EXTRACT_CANDIDATES <= 50);
  assert.ok(MAX_EXTRACT_CANDIDATE_CHARS >= 200 && MAX_EXTRACT_CANDIDATE_CHARS <= 4_000);
});

test("COMPARE_RELATIONS and ASPECT_RELATIONS share the same three keys", () => {
  const overall = Object.keys(COMPARE_RELATIONS).sort();
  const aspect = Object.keys(ASPECT_RELATIONS).sort();
  assert.deepEqual(overall, ["contradicts", "different_facts", "same_fact"]);
  assert.deepEqual(overall, aspect);
  // the aspect wording must say what "not both address it" means
  assert.match(ASPECT_RELATIONS.different_facts, /does not both|at least one/i);
});

// ── jev_review / jev_gate helpers ────────────────────────────────────────────

test("resolvePolicyThresholds fills and validates the threshold pair", () => {
  assert.deepEqual(resolvePolicyThresholds(0.8), { autoAccept: 0.8, reviewAt: 0.5 });
  // a lone low auto_accept cannot invert the pair
  assert.deepEqual(resolvePolicyThresholds(0.3), { autoAccept: 0.3, reviewAt: 0.3 });
  assert.deepEqual(resolvePolicyThresholds(0.9, 0.6), { autoAccept: 0.9, reviewAt: 0.6 });
  assert.throws(() => resolvePolicyThresholds(0.5, 0.8), /0 <= review_at <= auto_accept <= 1/);
  assert.throws(() => resolvePolicyThresholds(1.2), /0 <= review_at <= auto_accept <= 1/);
});

test("reviewComposite weights rubrics and inverts test gap and blast radius", () => {
  const perfect = reviewComposite({ correctness: 2, specMatch: 2, testGap: 0, blastRadius: 0 });
  assert.ok(Math.abs(perfect - 1) < 1e-9);
  const worst = reviewComposite({ correctness: 0, specMatch: 0, testGap: 2, blastRadius: 2 });
  assert.ok(Math.abs(worst - 0) < 1e-9);
  // out-of-range scores are clamped, never extrapolated
  const clamped = reviewComposite({ correctness: 9, specMatch: 3, testGap: -1, blastRadius: -5 });
  assert.ok(Math.abs(clamped - perfect) < 1e-9);
  // weights: correctness 0.4, spec match 0.3, tests 0.15, blast 0.15.
  // Good tests and tiny blast contribute fully, so zero them to isolate correctness.
  const mid = reviewComposite({ correctness: 2, specMatch: 0, testGap: 2, blastRadius: 2 });
  assert.ok(Math.abs(mid - 0.4) < 1e-9);
});

test("reviewAction gates auto on safe_to_apply, min confidence, and composite floor", () => {
  const pass = { composite: 0.9, safeToApply: 0.95, minConfidence: 0.9 };
  assert.equal(reviewAction({ ...pass, autoAccept: 0.8, reviewAt: 0.5, compositeFloor: 0.7 }), "auto");
  // composite below the floor demotes to review, not escalate
  assert.equal(reviewAction({ ...pass, composite: 0.5, autoAccept: 0.8, reviewAt: 0.5, compositeFloor: 0.7 }), "review");
  // a higher floor is respected
  assert.equal(reviewAction({ ...pass, composite: 0.75, autoAccept: 0.8, reviewAt: 0.5, compositeFloor: 0.8 }), "review");
  // low safe_to_apply or low min confidence escalates via review_at
  assert.equal(reviewAction({ ...pass, safeToApply: 0.4, autoAccept: 0.8, reviewAt: 0.5, compositeFloor: 0.7 }), "escalate");
  assert.equal(reviewAction({ ...pass, minConfidence: 0.2, autoAccept: 0.8, reviewAt: 0.5, compositeFloor: 0.7 }), "escalate");
  // between review_at and auto_accept reviews
  assert.equal(reviewAction({ ...pass, safeToApply: 0.6, autoAccept: 0.8, reviewAt: 0.5, compositeFloor: 0.7 }), "review");
});

test("reviewAction treats unknown confidence as escalate even at zero thresholds", () => {
  const pass = { composite: 0.9, safeToApply: 0.95, minConfidence: null };
  // A bare zero coercion would satisfy auto_accept 0 and review_at 0.
  assert.equal(reviewAction({ ...pass, autoAccept: 0, reviewAt: 0, compositeFloor: 0 }), "escalate");
  assert.equal(reviewAction({ ...pass, autoAccept: 0.8, reviewAt: 0.5, compositeFloor: 0.7 }), "escalate");
});

test("requireCompleteContext demotes only auto and preserves stronger actions", () => {
  assert.equal(requireCompleteContext("auto", true), "review");
  assert.equal(requireCompleteContext("auto", false), "auto");
  assert.equal(requireCompleteContext("escalate", true), "escalate");
  assert.equal(requireCompleteContext("review", true), "review");
});

test("claimAction escalates low confidence and confident contradictions", () => {
  assert.equal(claimAction("verified", 0.95, 0.8, 0.5), "auto");
  assert.equal(claimAction("verified", 0.6, 0.8, 0.5), "review");
  assert.equal(claimAction("verified", 0.3, 0.8, 0.5), "escalate");
  assert.equal(claimAction("contradicted", 0.95, 0.8, 0.5), "escalate");
  assert.equal(claimAction("contradicted", 0.6, 0.8, 0.5), "review");
  assert.equal(claimAction("unsupported", 0.95, 0.8, 0.5), "review");
});

test("claimAction treats unknown confidence as escalate even at zero thresholds", () => {
  assert.equal(claimAction("verified", null, 0, 0), "escalate");
  assert.equal(claimAction("verified", null, 0.8, 0.5), "escalate");
});

test("worstAction picks the most severe action", () => {
  assert.equal(worstAction(["auto", "review"]), "review");
  assert.equal(worstAction(["auto", "review", "escalate"]), "escalate");
  assert.equal(worstAction(["auto"]), "auto");
  assert.equal(worstAction([]), "auto");
});

test("normalizeEvidence and hasNonEmptyEvidence match jev_verify shapes", () => {
  assert.deepEqual(normalizeEvidence("just text"), [{ id: "evidence", text: "just text" }]);
  assert.deepEqual(normalizeEvidence({ text: "single" }), [{ id: "evidence0", text: "single" }]);
  const multi = normalizeEvidence([
    { id: "a", text: "one" },
    { id: "a", text: "two" },
  ]);
  assert.deepEqual(multi.map((e) => e.id), ["a", "a_1"]);
  assert.equal(hasNonEmptyEvidence(multi), true);
  assert.equal(hasNonEmptyEvidence([{ id: "x", text: "   \n " }]), false);
  assert.equal(hasNonEmptyEvidence([]), false);
});

test("review/gate caps keep real diffs reviewable", () => {
  assert.ok(MAX_REVIEW_DOC_CHARS >= 50_000, "per-document cap must fit real diffs");
  assert.ok(MAX_CLAIM_CHARS >= 500 && MAX_CLAIM_CHARS <= 4_000);
  assert.ok(MAX_GATE_CLAIMS >= 5 && MAX_GATE_CLAIMS <= 40);
});
