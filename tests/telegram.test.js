// Telegram channel tests — update parse, HTML conversion, inbound → reply.
// Uses injected senders so nothing hits the real Bot API.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTelegramUpdate,
  toTelegramHtml,
  sendTelegram,
  handleTelegramUpdate,
  chatUnreachable,
  telegramSecretOk,
} from "../src/telegram.js";
import { config } from "../src/config.js";

function fakeUpdate(text, chatId = "123456789", updateId = 1001) {
  return {
    update_id: updateId,
    message: {
      message_id: 5,
      from: { id: 987654321, is_bot: false, first_name: "Harbi" },
      chat: { id: Number(chatId), type: "private", first_name: "Harbi" },
      date: 1788934045,
      text,
    },
  };
}

test("parseTelegramUpdate: extracts chatId/text/name from a text message", () => {
  const u = parseTelegramUpdate(fakeUpdate("buy airtime"));
  assert.equal(u.chatId, "123456789");
  assert.equal(u.text, "buy airtime");
  assert.equal(u.name, "Harbi");
  assert.equal(u.updateId, 1001);
});

test("parseTelegramUpdate: normalizes /start and /help", () => {
  assert.equal(parseTelegramUpdate(fakeUpdate("/start")).text, "hello");
  assert.equal(parseTelegramUpdate(fakeUpdate("/help")).text, "help");
  assert.equal(parseTelegramUpdate(fakeUpdate("/start hi EDAY")).text, "hi EDAY");
});

test("parseTelegramUpdate: non-message / non-text updates are null", () => {
  assert.equal(parseTelegramUpdate({ update_id: 1, my_chat_member: {} }), null);
  assert.equal(parseTelegramUpdate({ update_id: 2, message: { chat: { id: 1 }, text: "" } }), null);
});

test("toTelegramHtml: escapes HTML and converts **bold**", () => {
  assert.equal(toTelegramHtml("Buy **₦500** airtime & data <now>"), "Buy <b>₦500</b> airtime &amp; data &lt;now&gt;");
  assert.equal(toTelegramHtml("# heading\ntext"), "heading\ntext"); // markdown heading markers stripped
});

test("sendTelegram: chunks long replies at 4000 and dry-runs without network", async () => {
  const sent = [];
  const fake = async (to, text) => { sent.push(text); };
  config.telegramDryRun = true;
  const r1 = await sendTelegram("123", "short", fake);
  assert.equal(r1.dry_run, true);
  config.telegramDryRun = false;
  const r2 = await sendTelegram("123", "x".repeat(9000), fake);
  assert.equal(r2.sent, true);
  assert.ok(sent.length >= 3, "long reply chunked under the 4096 cap");
  assert.ok(sent.every((c) => c.length <= 4000));
});

test("handleTelegramUpdate: help → reply is sent back (fake sender)", async () => {
  const sent = [];
  const fake = async (to, text) => { sent.push({ to, text }); };
  config.telegramDryRun = false;
  config.telegramAck = false;
  const res = await handleTelegramUpdate(fakeUpdate("help"), { sender: fake });
  assert.equal(res.received, 1);
  assert.ok(sent.length >= 1);
  assert.equal(sent[0].to, "123456789");
  assert.match(sent[0].text, /help|airtime/i);
});

test("handleTelegramUpdate: duplicate update_id is skipped", async () => {
  let calls = 0;
  const fake = async () => { calls++; };
  config.telegramAck = false;
  config.telegramDryRun = false;
  const body = fakeUpdate("hello", "123456789", 2001);
  await handleTelegramUpdate(body, { sender: fake });
  await handleTelegramUpdate(body, { sender: fake });
  assert.equal(calls, 1, "same update_id only processed once");
});

test("chatUnreachable: only blocked/closed chats are quiet failures", () => {
  const e = new Error("telegram send HTTP 403: Forbidden: bot was blocked by the user");
  e.code = 403;
  assert.equal(chatUnreachable(e), true);
  assert.equal(chatUnreachable(new Error("HTTP 500 boom")), false);
});

test("telegramSecretOk: configured secret must match header", () => {
  config.telegramSecret = "s3cret";
  assert.equal(telegramSecretOk("s3cret"), true);
  assert.equal(telegramSecretOk("nope"), false);
  config.telegramSecret = "";
  assert.equal(telegramSecretOk(undefined), true); // unset → skip check
});
