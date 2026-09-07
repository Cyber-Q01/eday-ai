// EDAY AI orchestration — tests (mock LLM mode, no API keys needed).
// Run: npm test   (node --test tests/)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../src/orchestrator.js";
import * as backend from "../src/backend.js";
import { memory } from "../src/memory.js";

function fresh() { return { session_id: "s_" + Math.random().toString(36).slice(2, 10), user_id: "tu_" + Math.random().toString(36).slice(2, 10), channel: "test" }; }

test("greeting returns welcome + hint", async () => {
  const out = await handleMessage({ ...fresh(), message: "hello" });
  assert.match(out.reply, /EDAY assistant/);
});

test("airtime flow: asks confirm, debits wallet only after yes", async () => {
  const s = fresh();
  const beforeBal = backend.actions.wallet_balance(s.user_id).balance;
  const r1 = await handleMessage({ ...s, message: "buy 500 naira mtn airtime for 08031234567" });
  assert.equal(r1.pending_confirm, true, "should require confirmation for payment");
  assert.match(r1.reply, /₦500/);
  // no money moved yet
  assert.equal(backend.actions.wallet_balance(s.user_id).balance, beforeBal);
  const r2 = await handleMessage({ ...s, message: "yes" });
  assert.equal(r2.pending_confirm, false);
  assert.match(r2.reply, /MTN airtime/);
  assert.equal(backend.actions.wallet_balance(s.user_id).balance, beforeBal - 500);
});

test("electricity: meter validated, token returned, disco inferred from meter", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "pay 5000 electricity for meter 41234567890" });
  assert.equal(r1.pending_confirm, true);
  const r2 = await handleMessage({ ...s, message: "yes" });
  assert.match(r2.reply, /kWh purchased/);
  assert.match(r2.reply, /Token: \d{13}/);
});

test("electricity: unknown meter is refused politely (after confirm, before charge)", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "pay 5000 for meter 99999999999" });
  assert.equal(r1.pending_confirm, true);
  const r2 = await handleMessage({ ...s, message: "yes" });
  assert.equal(r2.pending_confirm, false);
  assert.match(r2.reply, /meter|Meter/);
  assert.doesNotMatch(r2.reply, /Token:/);
});

test("send quote → book → confirm → order created", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "send a package from Ikeja Lagos to Yaba Lagos" });
  assert.match(r1.reply, /quotes/i);
  const r2 = await handleMessage({ ...s, message: "book it" });
  assert.equal(r2.pending_confirm, true);
  const r3 = await handleMessage({ ...s, message: "yes" });
  assert.equal(r3.pending_confirm, false);
  assert.match(r3.reply, /Booked/);
});

test("wallet balance reply", async () => {
  const out = await handleMessage({ ...fresh(), message: "what is my wallet balance?" });
  assert.match(out.reply, /wallet balance/i);
});

test("offscope refused", async () => {
  const out = await handleMessage({ ...fresh(), message: "transfer 1 million to my cousin in London" });
  assert.match(out.reply, /only help with EDAY/i);
});

test("ride quote then book the car", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "book a ride from Ikeja to the airport" });
  assert.match(r1.reply, /🚗/);
  const r2 = await handleMessage({ ...s, message: "book the car" });
  assert.equal(r2.pending_confirm, true);
  const r3 = await handleMessage({ ...s, message: "yes" });
  assert.match(r3.reply, /Car booked/);
});

test("stay search then pick by number", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "find a hotel in Ibadan for 1 night" });
  assert.match(r1.reply, /Stays in \*\*Ibadan\*\*/);
  const r2 = await handleMessage({ ...s, message: "1" });
  assert.equal(r2.pending_confirm, true, "booking must be confirmed");
  const r3 = await handleMessage({ ...s, message: "yes" });
  assert.match(r3.reply, /confirmed/);
});

test("decline after confirm: no charge", async () => {
  const s = fresh();
  const before = backend.actions.wallet_balance(s.user_id).balance;
  await handleMessage({ ...s, message: "buy 1000 naira glo airtime for 09011234567" });
  const r2 = await handleMessage({ ...s, message: "no" });
  assert.equal(r2.pending_confirm, false);
  assert.match(r2.reply, /nothing was charged/);
  assert.equal(backend.actions.wallet_balance(s.user_id).balance, before);
});

test("memory: preference saved after airtime, recalled, and forget works", async () => {
  const s = fresh();
  await memory.forget(s.user_id);
  await handleMessage({ ...s, message: "buy 500 naira airtel airtime for 08123456789" });
  await handleMessage({ ...s, message: "yes" });
  const mem = await memory.recall(s.user_id);
  assert.ok(mem.prefs.some((p) => p.key === "default_airtime_phone"));
  await memory.forget(s.user_id);
  assert.deepEqual(await memory.recall(s.user_id), { prefs: [], recent_episodes: [] });
});

test("concurrent wallet debits can't go negative", async () => {
  const u = "race_user";
  const bal0 = backend.actions.wallet_balance(u).balance; // 50000
  // fire 12 concurrent airtime buys of 5000 (would need 60000 > 50000) with confirms skipped
  const jobs = Array.from({ length: 12 }, async () => {
    const s = fresh();
    await handleMessage({ ...s, user_id: u, message: "buy 5000 naira mtn airtime for 08031234567" });
    await handleMessage({ ...s, user_id: u, message: "yes" });
  });
  await Promise.all(jobs);
  const bal = backend.actions.wallet_balance(u).balance;
  assert.ok(bal >= 0, "balance must never be negative");
  assert.equal(bal0 % 5000, bal % 5000, "balance should drop in exact 5000 steps");
});
