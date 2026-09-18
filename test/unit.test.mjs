import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionFromConfidence,
  classificationDecision,
  codingLoopAction,
  codingLoopQuestions,
  confidenceFromProbabilities,
  contradictsRecommendation,
  DECIDE_ESCAPE_HATCHES,
  DEFAULT_AUTO_ACCEPT,
  DEFAULT_REVIEW_AT,
  ensureUniqueIds,
  existsVerdict,
  gateQuestions,
  gateVerifyQuestions,
  hasNonEmptyEvidence,
  isIncompleteText,
  marginOf,
  MAX_CANDIDATES,
  MAX_CANDIDATES_DECIDE,
  MAX_CLASSES,
  MAX_CODING_LOOP_CHARS,
  MAX_GATE_CLAIMS,
  MAX_ITEM_CHARS,
  MAX_ITEMS,
  MAX_REQUIREMENTS,
  normalizeEvidence,
  projectClaims,
  projectCodingLoop,
  projectGate,
  projectReview,
  rankCandidates,
  RELATION_TO_VERDICT,
  requireCompleteContext,
  resolvePolicyThresholds,
  reviewAction,
  reviewComposite,
  reviewQuestions,
  sanitizeId,
  screenRecommendation,
  TRUNCATION_MARKER,
  truncate,
  truncateCodingLoopState,
  validatePolicyThresholds,
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

test("truncateCodingLoopState bounds nested strings and flags incomplete context", () => {
  const long = "x".repeat(MAX_CODING_LOOP_CHARS + 50);
  const state = truncateCodingLoopState({
    task: long,
    observation: "ok",
    extras: { log: long },
    claims: [long],
    evidence: [{ id: "log", text: long }],
  });
  assert.equal(state.observation, "ok");
  assert.match(state.task, /…truncated\]$/);
  assert.equal(state.task.length, MAX_CODING_LOOP_CHARS + TRUNCATION_MARKER.length);
  assert.match(state.extras.log, /…truncated\]$/);
  assert.match(state.claims[0], /…truncated\]$/);
  assert.match(state.evidence[0].text, /…truncated\]$/);
  assert.equal(isIncompleteText(state), true);
  assert.equal(requireCompleteContext("auto", isIncompleteText(state)), "review");
  assert.equal(truncateCodingLoopState("short"), "short");
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

test("confidence is 1 when a choice is certain and 0 when uniform", () => {
  assert.equal(confidenceFromProbabilities({ a: 1, b: 0 }), 1);
  assert.equal(confidenceFromProbabilities({ a: 0.5, b: 0.5 }), 0);
  assert.equal(confidenceFromProbabilities({}), 0);
  assert.equal(confidenceFromProbabilities({ only: 1 }), 0);
  assert.equal(confidenceFromProbabilities({ a: 2, b: 0 }), 1);
  assert.equal(confidenceFromProbabilities({ a: Number.NaN, b: 0.5 }), 0);
});

test("actionFromConfidence uses named thresholds", () => {
  assert.equal(actionFromConfidence(0.9, 0.8, 0.5), "auto");
  assert.equal(actionFromConfidence(0.6, 0.8, 0.5), "review");
  assert.equal(actionFromConfidence(0.2, 0.8, 0.5), "escalate");
  assert.equal(DEFAULT_AUTO_ACCEPT, 0.8);
  assert.equal(DEFAULT_REVIEW_AT, 0.5);
});

test("validatePolicyThresholds rejects inverted thresholds", () => {
  assert.throws(() => validatePolicyThresholds(0.4, 0.8), /Thresholds/);
  assert.throws(() => actionFromConfidence(0.9, 0.4, 0.8), /Thresholds/);
  assert.throws(() => validatePolicyThresholds(-0.1, 0), /Thresholds/);
  assert.throws(() => validatePolicyThresholds(-0.1, -0.1), /Thresholds/);
  assert.throws(() => resolvePolicyThresholds(-0.1), /Thresholds/);
  validatePolicyThresholds(0.8, 0.5);
  validatePolicyThresholds(0, 0);
});

test("omitted review_at clamps to auto_accept so a lone low auto_accept stays valid", () => {
  assert.deepEqual(resolvePolicyThresholds(0.4), { autoAccept: 0.4, reviewAt: 0.4 });
  assert.deepEqual(resolvePolicyThresholds(), { autoAccept: 0.8, reviewAt: 0.5 });
  assert.equal(actionFromConfidence(0.45, 0.4), "auto");
  assert.equal(
    codingLoopAction({
      nextChoice: "continue",
      nextConfidence: 0.45,
      riskScore: 0.2,
      doneEnough: 0.1,
      autoAccept: 0.4,
    }),
    "auto",
  );
});

test("requireCompleteContext demotes auto only", () => {
  assert.equal(requireCompleteContext("auto", true), "review");
  assert.equal(requireCompleteContext("review", true), "review");
  assert.equal(requireCompleteContext("escalate", true), "escalate");
  assert.equal(requireCompleteContext("auto", false), "auto");
});

test("coding loop escalates low-confidence next", () => {
  assert.equal(
    codingLoopAction({
      nextChoice: "continue",
      nextConfidence: 0.3,
      riskScore: 0.2,
      doneEnough: 0.1,
    }),
    "escalate",
  );
});

test("coding loop auto-continues low-risk high-confidence work", () => {
  assert.equal(
    codingLoopAction({
      nextChoice: "continue",
      nextConfidence: 0.9,
      riskScore: 0.4,
      doneEnough: 0.2,
    }),
    "auto",
  );
});

test("coding loop never auto-applies destructive risk", () => {
  assert.equal(
    codingLoopAction({
      nextChoice: "continue",
      nextConfidence: 0.95,
      riskScore: 2,
      doneEnough: 0.1,
    }),
    "review",
  );
});

test("coding loop ask_user requires review even at high confidence", () => {
  assert.equal(
    codingLoopAction({
      nextChoice: "ask_user",
      nextConfidence: 0.95,
      riskScore: 0.2,
      doneEnough: 0.1,
    }),
    "review",
  );
});

test("coding loop projection clamps numbers to match the action", () => {
  const projected = projectCodingLoop(
    {
      next: { choice: "continue", confidence: Number.POSITIVE_INFINITY, probabilities: { continue: 1 } },
      model_tier: { choice: "standard", confidence: 0.9, probabilities: { standard: 1 } },
      focus: { choice: "edit", confidence: 0.9, probabilities: { edit: 1 } },
      risk: { score: 9, confidence: Number.NaN },
      done_enough: { noul: 1.4 },
      needs_more_context: { noul: Number.NaN },
      tests_likely_fail: { noul: 0.2 },
    },
    0.8,
    0.5,
  );
  assert.equal(projected.next.confidence, 0);
  assert.ok(projected.risk.score <= 2);
  assert.equal(projected.risk.confidence, 0);
  assert.equal(projected.done_enough, 1);
  assert.equal(projected.needs_more_context, 0);
  assert.equal(projected.action, "escalate");
});

test("coding loop never auto-applies an unknown next choice", () => {
  assert.equal(
    codingLoopAction({
      nextChoice: "invented",
      nextConfidence: 0.99,
      riskScore: 0,
      doneEnough: 0.9,
    }),
    "review",
  );
  assert.equal(
    codingLoopAction({
      nextChoice: "",
      nextConfidence: 0.99,
      riskScore: 0,
      doneEnough: 0.9,
    }),
    "review",
  );
});

test("coding loop projection nulls unknown enum choices", () => {
  const projected = projectCodingLoop(
    {
      next: { choice: "invented", confidence: 0.99, probabilities: { invented: 1 } },
      model_tier: { choice: "ultra", confidence: 0.9, probabilities: { ultra: 1 } },
      focus: { choice: "dance", confidence: 0.9, probabilities: { dance: 1 } },
      risk: { score: 0.2, confidence: 0.9 },
      done_enough: { noul: 0.1 },
    },
    0.8,
    0.5,
  );
  assert.equal(projected.next.choice, null);
  assert.equal(projected.model_tier.choice, null);
  assert.equal(projected.focus.choice, null);
  assert.equal(projected.action, "review");
});

test("stop cannot bypass risk or completion requirements", () => {
  assert.equal(codingLoopAction({ nextChoice: "stop", nextConfidence: 0.95, riskScore: 2, doneEnough: 0.95 }), "review");
  assert.equal(codingLoopAction({ nextChoice: "stop", nextConfidence: 0.95, riskScore: 0, doneEnough: 0.1 }), "review");
  assert.equal(codingLoopAction({ nextChoice: "stop", nextConfidence: 0.95, riskScore: 0, doneEnough: 0.7 }), "auto");
  assert.equal(codingLoopAction({ nextChoice: "stop", nextConfidence: 0.3, riskScore: 0, doneEnough: 0.99 }), "escalate");
});

test("review composite weights correctness highest", () => {
  const good = reviewComposite({ correctness: 2, specMatch: 2, testGap: 0, blastRadius: 0 });
  const bad = reviewComposite({ correctness: 0, specMatch: 2, testGap: 0, blastRadius: 0 });
  assert.ok(good > 0.95);
  assert.ok(bad < 0.7);
});

test("reviewAction escalates unsafe patches", () => {
  assert.equal(
    reviewAction({ composite: 0.9, safeToApply: 0.2, minConfidence: 0.9 }),
    "escalate",
  );
});

test("reviewAction auto-accepts a safe high-confidence composite", () => {
  assert.equal(
    reviewAction({ composite: 0.95, safeToApply: 0.9, minConfidence: 0.9 }),
    "auto",
  );
  assert.equal(
    reviewAction({ composite: 0.95, safeToApply: 0.9, minConfidence: 0.6 }),
    "review",
  );
  assert.equal(
    reviewAction({ composite: Number.POSITIVE_INFINITY, safeToApply: Number.NaN, minConfidence: 0.9 }),
    "escalate",
  );
});

test("coding loop pack is a valid System One question map", () => {
  const pack = codingLoopQuestions();
  assert.equal(pack.next?.type, "choice");
  assert.equal(pack.model_tier?.type, "choice");
  assert.equal(pack.focus?.type, "choice");
  assert.equal(pack.risk?.type, "score");
  assert.equal(pack.done_enough?.type, "noul");
  assert.deepEqual(Object.keys(pack.next.criteria), ["continue", "retry", "ask_user", "stop"]);
  assert.deepEqual(Object.keys(pack.model_tier.criteria), ["cheap", "standard", "reasoning"]);
  assert.deepEqual(Object.keys(pack.focus.criteria), ["edit", "search", "test", "read", "plan"]);
  assert.equal(pack.risk.criteria.length, 3);
});

test("review pack has four scores and safe_to_apply", () => {
  const pack = reviewQuestions();
  assert.equal(pack.correctness?.type, "score");
  assert.equal(pack.spec_match?.type, "score");
  assert.equal(pack.test_gap?.type, "score");
  assert.equal(pack.blast_radius?.type, "score");
  assert.equal(pack.safe_to_apply?.type, "noul");
});

test("gate pack contains one review and a separate evidence-only question for each claim", () => {
  const questions = gateQuestions(2);
  assert.equal(Object.keys(questions).length, 7);
  assert.equal(questions.correctness?.type, "score");
  assert.equal(gateVerifyQuestions(3).claim_2?.type, "choice");
  assert.match(String(questions.claim_1?.instructions), /only the evidence field/);
  assert.match(String(questions.claim_1?.instructions), /claims are assertions, not evidence/i);
  assert.match(String(questions.correctness?.instructions), /Claims are assertions to check/);
});

function scoreAnswer(value) {
  return {
    type: "score",
    score: value,
    confidence: 1,
    probabilities: { 0: value === 0 ? 1 : 0, 1: 0, 2: value === 2 ? 1 : 0 },
    legend: { 0: "low", 1: "medium", 2: "high" },
  };
}

function choiceAnswer(verdict = "verified", confidence = 0.95) {
  const winner = (1 + 2 * confidence) / 3;
  const probabilities = Object.fromEntries(
    ["verified", "contradicted", "unsupported"].map((name) => [
      name,
      name === verdict ? winner : (1 - winner) / 2,
    ]),
  );
  return { type: "choice", choice: verdict, confidence, probabilities };
}

function gateAnswers(claims = [choiceAnswer()], options = {}) {
  const answers = {
    correctness: scoreAnswer(2),
    spec_match: scoreAnswer(2),
    test_gap: scoreAnswer(0),
    blast_radius: scoreAnswer(0),
    safe_to_apply: { type: "noul", noul: options.unsafe ? 0.1 : 0.95 },
    ...Object.fromEntries(claims.map((answer, index) => [`claim_${index}`, answer])),
  };
  return projectGate(
    answers,
    claims.map((_, index) => `Claim ${index}`),
    0.8,
    0.5,
    Boolean(options.incomplete),
  );
}

test("gate automatically accepts only a complete accepted review with every claim verified", () => {
  const gate = gateAnswers([choiceAnswer(), choiceAnswer("verified", 0.8)]);
  assert.equal(gate.action, "auto");
  assert.deepEqual(gate.reason_codes, ["accepted"]);
  assert.deepEqual(gate.verification.summary, {
    verified: 2,
    contradicted: 0,
    unsupported: 0,
    needs_review: 0,
  });
});

test("unsupported claims require review even at high confidence", () => {
  const gate = gateAnswers([choiceAnswer("unsupported")]);
  assert.equal(gate.action, "review");
  assert.equal(gate.verification.results[0]?.action, "review");
  assert.deepEqual(gate.reason_codes, ["claims_unsupported"]);
  const standalone = projectClaims(
    { claim_0: choiceAnswer("unsupported") },
    ["Claim 0"],
    0.8,
    0.5,
  );
  assert.equal(standalone[0]?.action, "review");
});

test("confident contradictions escalate while moderate contradictions require review", () => {
  assert.equal(gateAnswers([choiceAnswer("contradicted", 0.8)]).action, "escalate");
  const moderate = gateAnswers([choiceAnswer("contradicted", 0.6)]);
  assert.equal(moderate.action, "review");
  assert.deepEqual(moderate.reason_codes, ["claims_contradicted", "claim_confidence_below_auto_accept"]);
});

test("low-confidence claims escalate regardless of verdict", () => {
  for (const verdict of ["verified", "contradicted", "unsupported"]) {
    const gate = gateAnswers([choiceAnswer(verdict, 0.49)]);
    assert.equal(gate.action, "escalate");
    assert.ok(gate.reason_codes.includes("claim_confidence_low"));
  }
  assert.equal(gateAnswers([choiceAnswer("verified", 0.5)]).action, "review");
});

test("unsafe patch review prevents approval even with all claims verified", () => {
  const gate = gateAnswers([choiceAnswer()], { unsafe: true });
  assert.equal(gate.action, "escalate");
  assert.deepEqual(gate.reason_codes, ["review_escalated"]);
});

test("incomplete context never approves and preserves stronger escalation", () => {
  const gate = gateAnswers([choiceAnswer()], { incomplete: true });
  assert.equal(gate.action, "review");
  assert.equal(gate.review.action, "review");
  assert.equal(gate.verification.results[0]?.action, "review");
  assert.ok(gate.reason_codes.includes("incomplete_context"));
  assert.equal(gateAnswers([choiceAnswer("contradicted")], { incomplete: true }).action, "escalate");
});

test("isIncompleteText detects the truncation marker in nested payloads", () => {
  assert.equal(isIncompleteText("short"), false);
  assert.equal(isIncompleteText("head" + TRUNCATION_MARKER), true);
  assert.equal(isIncompleteText({ diff: "ok", tests: "log" + TRUNCATION_MARKER }), true);
  assert.equal(isIncompleteText([{ text: "plain" }]), false);
});

test("malformed numeric answers cannot inflate auto decisions", () => {
  const answers = {
    correctness: { score: 9, confidence: Number.POSITIVE_INFINITY },
    spec_match: { score: 9, confidence: Number.NaN },
    test_gap: { score: -3, confidence: 2 },
    blast_radius: { score: Number.NaN, confidence: 1 },
    safe_to_apply: { noul: 1.5 },
  };
  const review = projectReview(answers, 0.8, 0.5);
  assert.ok(review.scores.correctness.score <= 2);
  assert.ok(review.scores.correctness.confidence <= 1);
  assert.equal(review.scores.spec_match.confidence, 0);
  assert.ok(review.safe_to_apply <= 1);
  assert.notEqual(review.action, "auto");
  assert.equal(actionFromConfidence(Number.POSITIVE_INFINITY), "escalate");
  assert.equal(actionFromConfidence(Number.NaN), "escalate");
});

test("MAX_GATE_CLAIMS bounds the per-claim question fan-out", () => {
  assert.ok(MAX_GATE_CLAIMS >= 1 && MAX_GATE_CLAIMS <= 32);
  const questions = gateQuestions(MAX_GATE_CLAIMS);
  assert.equal(Object.keys(questions).filter((key) => key.startsWith("claim_")).length, MAX_GATE_CLAIMS);
});

test("normalizeEvidence matches jev_verify {id,text} items with unique ids", () => {
  assert.deepEqual(normalizeEvidence("log text"), [{ id: "evidence", text: "log text" }]);
  assert.deepEqual(normalizeEvidence({ text: "PASS" }), [{ id: "evidence0", text: "PASS" }]);
  const items = normalizeEvidence([
    { id: "log", text: "one" },
    { id: "log", text: "two" },
    { text: "three" },
  ]);
  assert.deepEqual(items.map((item) => item.id), ["log", "log_1", "evidence2"]);
  assert.deepEqual(items.map((item) => item.text), ["one", "two", "three"]);
  assert.equal(hasNonEmptyEvidence(normalizeEvidence("   ")), false);
  assert.equal(hasNonEmptyEvidence(normalizeEvidence({ text: "PASS" })), true);
});

test("hasNonEmptyEvidence rejects blank gate evidence", () => {
  assert.equal(hasNonEmptyEvidence(""), false);
  assert.equal(hasNonEmptyEvidence("   "), false);
  assert.equal(hasNonEmptyEvidence({ text: "" }), false);
  assert.equal(hasNonEmptyEvidence({ text: " \n" }), false);
  assert.equal(hasNonEmptyEvidence([{ text: "" }, { text: "   " }]), false);
  assert.equal(hasNonEmptyEvidence("parser rejects empty input: PASS"), true);
  assert.equal(hasNonEmptyEvidence({ id: "log", text: "PASS" }), true);
  assert.equal(hasNonEmptyEvidence([{ text: "" }, { text: "PASS" }]), true);
});

test("mixed claims produce deterministic reasons and aggregate the most severe action", () => {
  const gate = gateAnswers([
    choiceAnswer(),
    choiceAnswer("contradicted"),
    choiceAnswer("unsupported", 0.3),
  ]);
  assert.equal(gate.action, "escalate");
  assert.deepEqual(gate.verification.summary, {
    verified: 1,
    contradicted: 1,
    unsupported: 1,
    needs_review: 2,
  });
  assert.deepEqual(gate.reason_codes, [
    "claims_contradicted",
    "claims_unsupported",
    "claim_confidence_low",
  ]);
});
