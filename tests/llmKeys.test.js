// Gemini multi-key rotation tests.
// Covers the fix for the user's free-tier 429 storms: with GEMINI_API_KEYS set,
// the client must rotate to the next key on quota/rate-limit/bad-key instead of
// falling straight back to the rule parser — and must stick with the key that
// worked so bursts don't re-hit the exhausted key every call.
// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

// Env BEFORE importing config.js — config reads env once at module load.
// Explicit values win over anything the repo .env provides.
process.env.LLM_PROVIDER = "gemini";
process.env.GEMINI_API_KEY = "key-primary";
process.env.GEMINI_API_KEYS = "key-b,key-c";
process.env.OPENAI_API_KEY = "";
process.env.LLM_BASE_URL = "";

const { llmEndpoint, effectiveLlmMode, geminiKeys } = await import("../src/config.js");
const { llmJson } = await import("../src/llm.js");

const okBody = JSON.stringify({ intent: "help", vertical: "none" });
const okResp = {
  model: "gemini-2.5-flash",
  choices: [{ message: { content: okBody } }],
  usage: { total_tokens: 12 },
};
const resp = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});

// Every Authorization header seen by fetch, in call order.
const calls = [];
// Every requested model, in call order (from the request body).
const models = [];
// handler(key, model) → Response; keys passed WITHOUT the "Bearer " prefix.
let handler = () => resp(200, okResp);
globalThis.fetch = async (_url, opts) => {
  const key = String(opts?.headers?.Authorization || "").replace(/^Bearer /, "");
  const model = String(JSON.parse(opts?.body || "{}").model || "");
  calls.push(key);
  models.push(model);
  return handler(key, model);
};

const reset = () => { calls.length = 0; models.length = 0; };

test("config: llmEndpoint exposes the full deduped key rotation list", () => {
  assert.equal(effectiveLlmMode(), "gemini");
  assert.deepEqual(geminiKeys(), ["key-primary", "key-b", "key-c"]);
  const ep = llmEndpoint();
  assert.equal(ep.key, "key-primary"); // back-compat primary
  assert.deepEqual(ep.keys, ["key-primary", "key-b", "key-c"]);
});

test("429 quota on primary key rotates to the next key and succeeds", async () => {
  reset(); // fresh cursor assumed at index 0 for the first LLM call
  handler = (key) =>
    key === "key-primary"
      ? resp(429, { error: { message: "Quota exceeded for quota metric 'GenerateContent'" } })
      : resp(200, okResp);
  const out = await llmJson("sys", "user");
  assert.equal(out.intent, "help");
  assert.deepEqual(calls, ["key-primary", "key-b"]); // rotate, no dead-end
});

test("rotation is sticky: next call starts at the key that worked", async () => {
  reset();
  handler = () => resp(200, okResp);
  await llmJson("sys", "user");
  assert.deepEqual(calls, ["key-b"]); // cursor remembered key-b — primary untouched
});

test("plain rate-limit (429, no quota) also rotates immediately", async () => {
  reset(); // cursor is on key-b after the sticky test
  handler = (key) =>
    key === "key-b"
      ? resp(429, { error: { message: "rate limit reached, retry later" } })
      : resp(200, okResp);
  const out = await llmJson("sys", "user");
  assert.equal(out.intent, "help");
  assert.deepEqual(calls, ["key-b", "key-c"]);
});

test("every key quota-exhausted → throws (caller falls back to rule parser), all keys tried", async () => {
  reset();
  handler = () => resp(429, { error: { message: "quota exceeded for all projects" } });
  await assert.rejects(() => llmJson("sys", "user"), /429/);
  // cursor was on key-c → tries all three before giving up
  assert.deepEqual([...new Set(calls)].sort(), ["key-b", "key-c", "key-primary"]);
});

test("404 (model unavailable to a key's project) falls through instead of aborting", async () => {
  reset(); // cursor on key-c after the failed chain above (unchanged on failure)
  // Simulate: the primary model 404s everywhere (new-project gate), the first
  // fallback model works — the call must succeed, not throw.
  handler = (_key, model) =>
    model === "gemini-flash-latest"
      ? resp(404, { error: { code: 404, message: "This model is no longer available", status: "NOT_FOUND" } })
      : resp(200, okResp);
  const out = await llmJson("sys", "user");
  assert.equal(out.intent, "help");
  // 404 walks every key for the dead model, then lands on the fallback model
  assert.deepEqual(models, ["gemini-flash-latest", "gemini-flash-latest", "gemini-flash-latest", "gemini-2.5-flash"]);
  assert.equal(calls.length, 4);
});

test("404 on the LAST model too → throws (nothing left to try)", async () => {
  reset();
  handler = () => resp(404, { error: { code: 404, message: "This model is no longer available", status: "NOT_FOUND" } });
  await assert.rejects(() => llmJson("sys", "user"), /404/);
});
