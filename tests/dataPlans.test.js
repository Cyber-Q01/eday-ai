// Data-plan flow + network-asking — regression tests.
// Covers the live failure reported from Telegram:
//   1. the bot GUESSED the network (LLM prompt said 'buy data default network
//      mtn', then flipped mtn→glo mid-flow) instead of asking;
//   2. the vendor rejected the vend with "Select a data plan" because chat
//      never listed plans — the app gets them from VTPass variations, chat
//      had no path to them at all.
// Run: npm test   (TOOL_MODE=mock via test.env — simulated backend, no keys)
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../src/orchestrator.js";

function fresh() {
  return { session_id: "s_" + Math.random().toString(36).slice(2, 10), user_id: "tu_" + Math.random().toString(36).slice(2, 10), channel: "test" };
}

test("buy data without a network ASKS for it instead of guessing", async () => {
  const s = fresh();
  const r = await handleMessage({ ...s, message: "I need to purchase a data" });
  assert.match(r.reply, /which network/i, "must ask for the network");
  assert.doesNotMatch(r.reply, /data plans:/i, "must not list plans for a guessed network");
});

test("buy airtime without a network ASKS for it (no mtn default)", async () => {
  const s = fresh();
  const r = await handleMessage({ ...s, message: "buy airtime for 08031234567" });
  assert.match(r.reply, /network/i, "must ask for the network");
  assert.equal(r.pending_confirm, false, "must not jump straight to a confirm");
});

test("full data flow: network → live plan list → number pick → phone → confirm → vend", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "buy data" });
  assert.match(r1.reply, /which network/i);

  const r2 = await handleMessage({ ...s, message: "mtn" });
  assert.match(r2.reply, /MTN data plans:/i, "must show the plan list once the network is known");
  assert.match(r2.reply, /1\. .+— ₦/i, "numbered rows with prices");
  assert.match(r2.reply, /reply with the number/i);

  const r3 = await handleMessage({ ...s, message: "4" }); // mock list: 1GB (30 days) ₦1,000
  assert.match(r3.reply, /phone number/i, "asks for the phone after the plan is picked");

  const r4 = await handleMessage({ ...s, message: "08031234567" });
  assert.match(r4.reply, /1GB/i, "confirm shows the chosen plan name");
  assert.match(r4.reply, /mtn/i);
  assert.equal(r4.pending_confirm, true);

  const r5 = await handleMessage({ ...s, message: "yes" });
  assert.match(r5.reply, /✅/);
  assert.match(r5.reply, /1GB .*MTN data activated/i, "vend success carries the plan name");
});

test("plan pick by SIZE ('1.5GB') resolves without needing list numbers", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "buy mtn data" });
  assert.match(r1.reply, /MTN data plans:/i, "network given up front → straight to the list");
  const r2 = await handleMessage({ ...s, message: "1.5GB" });
  assert.match(r2.reply, /phone number/i, "size reply resolves to a plan");
});

test("plan pick by PRICE matches the bundle that costs it", async () => {
  const s = fresh();
  await handleMessage({ ...s, message: "buy glo data" });
  const r = await handleMessage({ ...s, message: "2000" });
  assert.match(r.reply, /phone number/i, "₦2,000 resolves to the 2.9GB Glo plan");
});

test("an amount stated up front auto-picks the exact-price plan", async () => {
  const s = fresh();
  const r = await handleMessage({ ...s, message: "buy ₦500 airtel data for 08031234567" });
  assert.match(r.reply, /1GB/i, "confirm jumps straight to the ₦500 plan (1GB, 7 days)");
  assert.equal(r.pending_confirm, true);
});

test("an unresolvable plan reply re-shows the list instead of vending garbage", async () => {
  const s = fresh();
  await handleMessage({ ...s, message: "buy data" });
  await handleMessage({ ...s, message: "glo" });
  const r = await handleMessage({ ...s, message: "maybe something cheap?" });
  assert.match(r.reply, /GLO data plans:/i, "list re-shown");
  assert.ok(!/\*\*Yes\*\* to confirm/i.test(r.reply), "no confirm with an unresolved plan");
});

test("switching network WHILE picking a plan re-lists the new network", async () => {
  const s = fresh();
  await handleMessage({ ...s, message: "buy data" });
  await handleMessage({ ...s, message: "mtn" });
  const r = await handleMessage({ ...s, message: "airtel instead" });
  assert.match(r.reply, /AIRTEL data plans:/i, "re-listed for the new network");
});
