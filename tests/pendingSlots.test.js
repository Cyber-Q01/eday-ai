// Pending-slot answers — regression tests.
// Covers the live failure: after the bot asks for a missing pickup/destination,
// a bare "Ayegun" was re-classified offscope by the fallback intent parser
// (which has no memory), losing the whole half-done flow.
// Also covers explicitly labeled addresses ("Pickup is X. Delivery is Y")
// which the fallback parser previously missed entirely.
// Run: npm test   (TOOL_MODE=mock via test.env — simulated backend, no keys)
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../src/orchestrator.js";

function fresh() {
  return { session_id: "s_" + Math.random().toString(36).slice(2, 10), user_id: "tu_" + Math.random().toString(36).slice(2, 10), channel: "test" };
}

test("pending slot answer: bare 'Yaba' continues the send flow instead of offscope", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "send a package from ikeja" });
  assert.match(r1.reply, /destination/i, "flow should ask for the destination");
  const r2 = await handleMessage({ ...s, message: "Yaba" });
  assert.match(r2.reply, /delivery quotes/i, "bare area name must be treated as the destination answer");
  assert.doesNotMatch(r2.reply, /only help with EDAY/i);
});

test("pending slot answer works for rides too", async () => {
  const s = fresh();
  const r1 = await handleMessage({ ...s, message: "book a ride from ikeja" });
  assert.match(r1.reply, /destination/i);
  const r2 = await handleMessage({ ...s, message: "Lekki phase 1" });
  assert.match(r2.reply, /ikeja → Lekki phase 1/i, "ride quote should use the answered destination");
});

test("pending slot answer: labeled 'pickup … delivery …' message parses in fallback mode", async () => {
  const s = fresh();
  const r = await handleMessage({ ...s, message: "Pickup address is Olomi Ibadan\n\nDelivery is Ayegun Ibadan" });
  assert.match(r.reply, /delivery quotes/i, "labeled addresses must map to a send quote");
  assert.doesNotMatch(r.reply, /only help with EDAY/i);
});

test("pending slot answer: 'cancel' aborts the half-done flow", async () => {
  const s = fresh();
  await handleMessage({ ...s, message: "send a package from ikeja" });
  const r = await handleMessage({ ...s, message: "cancel" });
  assert.match(r.reply, /cancelled/i);
  // and the session is truly clean: a bare ack afterwards gets the nothing-pending reply
  const r2 = await handleMessage({ ...s, message: "ok" });
  assert.match(r2.reply, /nothing waiting/i);
});

test("pending slot answer: 'help' escapes to the menu instead of being eaten as an address", async () => {
  const s = fresh();
  await handleMessage({ ...s, message: "send a package from ikeja" });
  const r = await handleMessage({ ...s, message: "help" });
  assert.match(r.reply, /I can help you with/i);
});
