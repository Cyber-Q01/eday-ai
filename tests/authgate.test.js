// Auth-gate + linking end-to-end tests (gateway mode).
//
// Gateway env vars are set BEFORE any src import (config.js reads env at
// import time, and node --test runs each file in its own process), and fetch
// is stubbed — no keys, no network. The stub answers ONLY ai-actions calls;
// everything else (e.g. Telegram typing indicator) is a fake 200.
process.env.TOOL_MODE = "http";
process.env.BACKEND_INTERNAL_URL = "https://eday.test/functions/v1";
process.env.BACKEND_INTERNAL_KEY = "test-internal-key";

const calls = [];
let mode = "linked";            // linked | unlinked | down
let claimed = null;             // chat external_id once its code claim succeeded
let matchedPhone = null;        // wa external_id once its phone match succeeded

function stubFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes("/ai-actions")) return new Response("{}", { status: 200 });
    const body = JSON.parse(opts.body || "{}");
    calls.push({ url: u, headers: opts.headers || {}, body });
    const ok = (result, status = 200) =>
      new Response(JSON.stringify({ action: body.action, result }), { status });
    if (body.action === "resolve_user") {
      if (mode === "down") return new Response("{}", { status: 500 });
      const ch = body.args.channel, ext = body.args.external_id;
      const linked = ch === "telegram" ? claimed === ext : matchedPhone === ext;
      return ok(linked ? { user_id: "11111111-1111-4111-8111-111111111111", name: "Harbi", linked: true } : { linked: false });
    }
    if (body.action === "claim_channel_link_code") {
      if (body.args.code === "4829") { claimed = body.args.external_id; return ok({ user_id: "11111111-1111-4111-8111-111111111111", linked: true, name: "Harbi" }); }
      return ok({ error: "INVALID_OR_EXPIRED_CODE" }, 400);
    }
    if (body.action === "link_by_phone") {
      if (String(body.args.phone).endsWith("9990000009")) { matchedPhone = body.args.external_id; return ok({ user_id: "22222222-2222-4222-8222-222222222222", linked: true }); }
      return ok({ error: "NO_MATCHING_ACCOUNT" }, 404);
    }
    return ok({});
  };
}

const tgUpdate = (text, chatId) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 5, from: { id: 987654321, is_bot: false, first_name: "Harbi" }, chat: { id: Number(chatId), type: "private", first_name: "Harbi" }, date: 1788934045, text },
});
const waPayload = (text, from) => ({
  entry: [{ id: "x", changes: [{ value: { messaging_product: "whatsapp", messages: [{ from, id: `wamid_${Math.random()}`, type: "text", text: { body: text } }] } }] }],
});

import { test } from "node:test";
import assert from "node:assert/strict";

test("gate: unlinked telegram sender gets the not-linked reply and NO conversation", async () => {
  stubFetch(); calls.length = 0; mode = "unlinked";
  const { config } = await import("../src/config.js");
  config.telegramDryRun = true;
  const { handleTelegramUpdate } = await import("../src/telegram.js");
  const r = await handleTelegramUpdate(tgUpdate("hello", "7001"), { sender: async () => ({ sent: true }) });
  assert.match(r.reply, /isn't linked/i);
  assert.match(r.reply, /4-digit code/i);
  assert.equal(calls.filter((c) => c.body.action === "resolve_user").length, 1);
  assert.ok(!calls.some((c) => c.body.action === "wallet_balance"), "no tool may run for an unlinked sender");
});

test("gate: gateway outage fails CLOSED — no conversation, no crash", async () => {
  stubFetch(); calls.length = 0; mode = "down";
  const { handleTelegramUpdate } = await import("../src/telegram.js");
  const r = await handleTelegramUpdate(tgUpdate("buy 500 naira mtn airtime for 08031234567", "7002"), { sender: async () => ({ sent: true }) });
  assert.ok(r.gated || /isn't linked|link/i.test(r.reply || ""), "must not converse when the gate cannot resolve");
});

test("telegram linking: a 4-digit code from an unlinked chat claims and greets", async () => {
  stubFetch(); calls.length = 0; mode = "unlinked";
  const { handleTelegramUpdate } = await import("../src/telegram.js");
  const r = await handleTelegramUpdate(tgUpdate("4829", "7003"), { sender: async () => ({ sent: true }) });
  assert.match(r.reply, /^Linked\./);
  const claim = calls.find((c) => c.body.action === "claim_channel_link_code");
  assert.ok(claim, "claim must be attempted");
  assert.equal(claim.body.args.code, "4829");
  assert.match(claim.headers["Idempotency-Key"], /^ai-claim-7003-4829$/);
  const r2 = await handleTelegramUpdate(tgUpdate("hello", "7003"), { sender: async () => ({ sent: true }) });
  assert.ok(!r2.gated && !/isn't linked/i.test(r2.reply || ""), "linked chat must sail through");
});

test("telegram linking: a bad code gets a helpful retry answer, gate stays closed", async () => {
  stubFetch(); calls.length = 0; mode = "unlinked";
  const { handleTelegramUpdate } = await import("../src/telegram.js");
  const r = await handleTelegramUpdate(tgUpdate("0000", "7004"), { sender: async () => ({ sent: true }) });
  assert.match(r.reply, /isn't valid|fresh one/i);
  const r2 = await handleTelegramUpdate(tgUpdate("hello", "7004"), { sender: async () => ({ sent: true }) });
  assert.ok(r2.gated || /isn't linked/i.test(r2.reply || ""));
});

test("whatsapp: same registered phone auto-links on first message", async () => {
  stubFetch(); calls.length = 0; mode = "unlinked";
  const { handleWhatsappPayload } = await import("../src/whatsapp.js");
  const r = await handleWhatsappPayload(waPayload("hello", "2349990000009"), { sender: async () => ({ sent: true }) });
  assert.ok(!/isn't linked/i.test(r.reply || ""), "registered number must sail straight through");
  assert.ok(calls.some((c) => c.body.action === "link_by_phone"));
  const r2 = await handleWhatsappPayload(waPayload("hello", "2349990000009"), { sender: async () => ({ sent: true }) });
  assert.ok(!/isn't linked/i.test(r2.reply || ""));
});

test("whatsapp: an unregistered number is held at the gate", async () => {
  stubFetch(); calls.length = 0; mode = "unlinked";
  const { handleWhatsappPayload } = await import("../src/whatsapp.js");
  const r = await handleWhatsappPayload(waPayload("hello", "2347000000011"), { sender: async () => ({ sent: true }) });
  assert.match(r.reply, /isn't linked/i);
});

test("linked telegram user converses with their REAL UUID as user_id", async () => {
  stubFetch(); calls.length = 0; mode = "unlinked";
  const { handleTelegramUpdate } = await import("../src/telegram.js");
  await handleTelegramUpdate(tgUpdate("4829", "7007"), { sender: async () => ({ sent: true }) });
  calls.length = 0;
  await handleTelegramUpdate(tgUpdate("what is my wallet balance?", "7007"), { sender: async () => ({ sent: true }) });
  // The conversation's tool call must carry the REAL auth UUID (not tg_<chatId>).
  const toolCall = calls.find((c) => c.body.action === "wallet_balance");
  assert.ok(toolCall, "wallet tool must reach the gateway");
  assert.equal(toolCall.body.user_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(toolCall.body.channel, "telegram");
  assert.equal(toolCall.headers["x-internal-key"], "test-internal-key");
});
