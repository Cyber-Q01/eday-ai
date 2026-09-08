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

test("partial info (no amount) asks for the missing field — never crashes (fillFromPrefs async fix)", async () => {
  const s = fresh();
  const r = await handleMessage({ ...s, message: "buy mtn airtime for 08031234567" });
  // must get a helpful reply (not a TypeError)
  assert.match(r.reply, /need|Almost there|amount|phone/i);
});

test("partial send (no destination) asks for destination — never crashes", async () => {
  const s = fresh();
  const r = await handleMessage({ ...s, message: "send a package from ikeja" });
  assert.match(r.reply, /need|Almost there|destination/i);
});

test("partial electricity (no amount) asks politely — never crashes", async () => {
  const s = fresh();
  const r = await handleMessage({ ...s, message: "pay electricity for meter 41234567890" });
  assert.match(r.reply, /need|Almost there|amount/i);
});

// ---------- context retention across turns ----------
test("context: ride fare question answered from last quote", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "book a ride from ikeja to lekki" });
  assert.match(r1.reply, /Bike:/);
  const r2 = await handleMessage({ ...s, message: "what is the price of the bike" });
  assert.match(r2.reply, /bike/i);
  assert.match(r2.reply, /₦/);
});

test("context: 'do the same again' re-runs last confirmed purchase", async () => {
  const s = fresh();
  await handleMessage({ ...s, message: "buy 500 naira mtn airtime for 08031234567" });
  const bal1 = backend.actions.wallet_balance(s.user_id).balance;
  const y = await handleMessage({ ...s, message: "yes" });
  assert.equal(backend.actions.wallet_balance(s.user_id).balance, bal1 - 500);
  const ag = await handleMessage({ ...s, message: "do the same again" });
  assert.equal(ag.pending_confirm, true, "reuse goes through the confirm gate");
  const y2 = await handleMessage({ ...s, message: "yes" });
  assert.equal(y2.pending_confirm, false);
  assert.equal(backend.actions.wallet_balance(s.user_id).balance, bal1 - 1000, "charged again");
});

test("context: 'what did i just do' recalls last action", async () => {
  const s = fresh();
  await handleMessage({ ...s, message: "buy 500 naira mtn airtime for 08031234567" });
  await handleMessage({ ...s, message: "yes" });
  const r = await handleMessage({ ...s, message: "what did i just do" });
  assert.match(r.reply, /airtime purchase/i);
});

test("context: track my last order after a chop order", async () => {
  const s = fresh();
  await handleMessage({ ...s, message: "order jollof rice and chicken in ibadan" });
  const y = await handleMessage({ ...s, message: "yes" });
  assert.match(y.reply, /ORD_/);
  const r = await handleMessage({ ...s, message: "track my last order" });
  assert.match(r.reply, /ORD_/);
  assert.match(r.reply, /chop/);
});

test("context: edit a pending confirmation (make it 1000 instead)", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "buy 500 naira mtn airtime for 08031234567" });
  assert.equal(r1.pending_confirm, true);
  const ed = await handleMessage({ ...s, message: "make it 1000 instead" });
  assert.equal(ed.pending_confirm, true);
  assert.match(ed.reply, /₦1,000/);
  const bal0 = backend.actions.wallet_balance(s.user_id).balance;
  const y = await handleMessage({ ...s, message: "yes" });
  assert.equal(backend.actions.wallet_balance(s.user_id).balance, bal0 - 1000);
});

test("context: track-my-last-order with no order yet answers helpfully (no hallucinated ref)", async () => {
  const s = fresh();
  await handleMessage({ ...s, message: "buy 500 naira mtn airtime for 08031234567" });
  await handleMessage({ ...s, message: "yes" }); // airtime → no order id
  const r = await handleMessage({ ...s, message: "track my last order" });
  assert.match(r.reply, /don't have a bookable order|order IDs come from/i);
});

test("chatter: thanks gets a friendly reply (fast path, no LLM)", async () => {
  const s = fresh();
  const r = await handleMessage({ ...s, message: "thanks a lot" });
  assert.match(r.reply, /welcome|glad/i);
});

test("chatter: bye gets a goodbye", async () => {
  const s = fresh();
  const r = await handleMessage({ ...s, message: "bye" });
  assert.match(r.reply, /Bye|👋/i);
});

test("help is answered instantly even when the LLM is down", async () => {
  const s = fresh();
  const r = await handleMessage({ ...s, message: "help" });
  assert.match(r.reply, /I can help you with/i);
  // and again after a complex turn (session memory intact)
  await handleMessage({ ...s, message: "buy 500 naira mtn airtime for 08031234567" });
  const r2 = await handleMessage({ ...s, message: "help" });
  assert.match(r2.reply, /I can help you with/i);
});
