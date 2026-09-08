// WhatsApp Cloud API bridge tests — handshake, signature, inbound → reply.
// Uses an injected sender so nothing hits the real Graph API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyHandshake,
  signatureOk,
  extractMessages,
  sendWhatsApp,
  handleWhatsappPayload,
} from "../src/whatsapp.js";
import { config } from "../src/config.js";

function fakePayload(text, from = "2348012345678") {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "x", changes: [{ value: { messaging_product: "whatsapp", messages: [{ from, id: "wamid_1", type: "text", text: { body: text } }] } }] }],
  };
}

test("extractMessages: pulls text + interactive button replies", () => {
  const msgs = extractMessages(fakePayload("hello"));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].from, "2348012345678");
  assert.equal(msgs[0].text, "hello");

  const btn = extractMessages({
    entry: [{ changes: [{ value: { messages: [{ from: "x", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes" } } }] } }] }],
  });
  assert.equal(btn[0].text, "Yes");
});

test("sendWhatsApp chunks long replies and dry-runs without network", async () => {
  const sent = [];
  const fake = async (to, text) => { sent.push({ to, len: text.length }); };
  config.whatsappDryRun = true;
  const r1 = await sendWhatsApp("2348012345678", "short reply", fake);
  assert.equal(r1.dry_run, true);
  config.whatsappDryRun = false;
  const long = "x".repeat(9000);
  const r2 = await sendWhatsApp("2348012345678", long, fake);
  assert.equal(r2.chunks, 3);
  assert.equal(sent.length, 3);
});

test("handleWhatsappPayload: airtime request → confirm reply is sent back on same thread", async () => {
  const sent = [];
  const fake = async (to, text) => { sent.push({ to, text }); };
  // mock LLM + memory so the test is hermetic
  const prevLlm = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "mock";
  const res = await handleWhatsappPayload(fakePayload("buy 500 naira mtn airtime for 08031234567"), { sender: fake });
  assert.equal(res.received, 1);
  assert.equal(res.replied, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "2348012345678");
  assert.match(sent[0].text, /confirm/i);
  assert.match(sent[0].text, /₦500/);
  process.env.LLM_PROVIDER = prevLlm;
});

test("webhook handshake: valid token returns challenge, wrong token returns null", () => {
  const good = new URL("http://x/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=" + config.whatsappVerifyToken + "&hub.challenge=1158201444");
  assert.equal(verifyHandshake(good), "1158201444");
  const bad = new URL("http://x/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1");
  assert.equal(verifyHandshake(bad), null);
});

test("signature check: valid HMAC passes, tampered body fails (when app secret set)", () => {
  const secret = config.whatsappAppSecret;
  if (!secret) { assert.ok(true, "app secret not configured — signature skipped by design"); return; }
  const raw = JSON.stringify(fakePayload("hi"));
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(signatureOk(raw, sig), true);
  assert.equal(signatureOk(raw + "tampered", sig), false);
  assert.equal(signatureOk(raw, null), false);
});

test("sendWhatsApp: retries transient failures then succeeds", async () => {
  const config2 = { ...config };
  let calls = 0;
  const flaky = async (to, text) => {
    calls++;
    if (calls === 1) throw new Error("whatsapp send HTTP 429: rate limited");
    if (calls === 2) throw new Error("whatsapp send HTTP 500: oops");
    return { ok: true };
  };
  config.whatsappDryRun = false;
  const r = await sendWhatsApp("2348000000000", "retry me", flaky);
  assert.equal(r.sent, true);
  assert.equal(calls, 3);
});

test("sendWhatsApp: converts **bold** to *bold* (WhatsApp markdown)", async () => {
  const sent = [];
  const fake = async (to, text) => { sent.push(text); };
  config.whatsappDryRun = false;
  await sendWhatsApp("2348000000000", "Buy **₦500** airtime for *mtn*?", fake);
  assert.match(sent[0], /Buy \*₦500\* airtime/);
  assert.ok(!sent[0].includes("**"));
});
