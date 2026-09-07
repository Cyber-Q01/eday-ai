// Embedder tests — deterministic mock embedder + cosine similarity (no keys needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockEmbed, cosine, normalize, toVectorLiteral } from "../src/embed.js";

test("mock embedder: deterministic + fixed dimension", () => {
  const a = mockEmbed("buy mtn airtime for my brother");
  const b = mockEmbed("buy mtn airtime for my brother");
  assert.equal(a.length, 768);
  assert.deepEqual(Array.from(a), Array.from(b), "same text → same vector");
});

test("mock embedder: related text is more similar than unrelated", () => {
  const query = mockEmbed("send a package from lagos");
  const related = mockEmbed("send package lagos courier delivery");
  const unrelated = mockEmbed("book hotel abuja electricity token");
  assert.ok(cosine(query, related) > cosine(query, unrelated), "related > unrelated");
  assert.ok(cosine(query, related) > 0.4);
});

test("vectors are L2-normalised → cosine in [-1,1]", () => {
  const v = mockEmbed("random words here zebra kettle");
  let sum = 0;
  for (const x of v) sum += x * x;
  assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-9);
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);
});

test("toVectorLiteral produces a parseable pgvector literal", () => {
  const v = normalize([1, 2, 3]);
  const lit = toVectorLiteral(v);
  assert.match(lit, /^\[[\d.,\-]+\]$/);
  // 768 values in the literal
  assert.equal(lit.split(",").length, 3); // normalize([1,2,3]) stays 3-dim here
});

test("gemini provider not required: effective mode falls back to mock without key", async () => {
  const { embedText } = await import("../src/embed.js");
  // env has no GEMINI key in tests → provider mock
  const out = await embedText("hello world");
  assert.equal(out.provider, "mock");
  assert.equal(out.vector.length, 768);
});
