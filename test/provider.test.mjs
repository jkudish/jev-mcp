import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptVercelAnswers } from "../dist/provider.js";

test("Vercel missing answers become an empty object", () => {
  assert.deepEqual(adaptVercelAnswers({}), {});
});

test("Vercel null answers become an empty object", () => {
  assert.deepEqual(adaptVercelAnswers({ answers: null }), {});
});

test("Vercel empty answers remain an empty object", () => {
  assert.deepEqual(adaptVercelAnswers({ answers: {} }), {});
});

for (const probability of [0, 0.73]) {
  test(`Vercel boolean probability ${probability} becomes noul unchanged`, () => {
    assert.deepEqual(
      adaptVercelAnswers({ answers: { injection: { type: "boolean", probability } } }),
      { injection: { type: "noul", noul: probability } },
    );
  });
}

for (const type of ["choice", "score"]) {
  const value = type === "choice" ? "allow" : 0;
  const probabilities = type === "choice" ? { allow: 0.8, deny: 0.2 } : { 0: 0.8, 1: 0.2 };

  for (const confidence of [0, 0.91]) {
    test(`Vercel ${type} preserves its value, distribution, and metadata confidence ${confidence}`, () => {
      const result = {
        answers: { decision: { type, [type]: value, probabilities, confidence: 0.5 } },
        providerMetadata: { typesafe: { confidence: { decision: confidence } } },
      };
      const original = structuredClone(result);
      assert.deepEqual(adaptVercelAnswers(result), {
        decision: { type, [type]: value, probabilities, confidence },
      });
      assert.deepEqual(result, original);
    });
  }

  test(`Vercel ${type} defaults missing confidence to null`, () => {
    for (const providerMetadata of [undefined, {}, { typesafe: {} }, { typesafe: { confidence: { other: 0.9 } } }]) {
      assert.deepEqual(adaptVercelAnswers({
        answers: { decision: { type, [type]: value, probabilities, confidence: 0.5 } },
        providerMetadata,
      }), {
        decision: { type, [type]: value, probabilities, confidence: null },
      });
    }
  });

  test(`Vercel ${type} keeps missing or null probabilities absent`, () => {
    // An absent distribution must stay absent, not become {}: tools treat
    // absent as "not reported" and present-but-malformed as invalid.
    for (const probabilities of [undefined, null]) {
      assert.deepEqual(adaptVercelAnswers({ answers: { decision: { type, [type]: value, probabilities } } }), {
        decision: { type, [type]: value, confidence: null },
      });
    }
  });
}

test("Vercel null answer entry passes through without throwing", () => {
  assert.deepEqual(adaptVercelAnswers({ answers: { injection: null } }), { injection: null });
});
