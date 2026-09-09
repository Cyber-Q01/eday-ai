// ---- Telegram social channel -----------------------------------------------
// Lets real users chat with EDAY from Telegram:
//   POST /webhook/telegram  → Telegram Bot API update (JSON) → handleMessage()
//                             → reply via sendMessage + a native "typing…" action.
// Telegram needs NO publishing/approval/whitelist: create a bot with @BotFather
// (free), point its webhook at this server, and anyone can message the bot.
// Each chat becomes an EDAY user ("tg_<chatId>") with a sticky session, so
// memory + confirmations persist across messages.
//
// Config (env): TELEGRAM_BOT_TOKEN (required — from @BotFather)
//               TELEGRAM_SECRET (optional — must match the secret_token set on
//                                the webhook) · TELEGRAM_DRY_RUN · TELEGRAM_ACK
import { config } from "./config.js";
import { log } from "./util.js";
import { handleMessage } from "./orchestrator.js";
import { audit } from "./audit.js";

export function telegramConfigured() {
  return Boolean(config.telegramBotToken);
}

const botApi = (method, params) =>
  fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });

/** Optional: verify X-Telegram-Bot-Api-Secret-Token (set at webhook registration). */
export function telegramSecretOk(header) {
  if (!config.telegramSecret) return true; // not configured → skip
  if (!header) return false;
  return String(header) === config.telegramSecret;
}

/**
 * Parse a Telegram Bot API update. Returns { chatId, text, msgId, fromId, name,
 * updateId } or null for non-text/non-message updates. Leading /start and /help
 * commands are normalized ("/start" → greeting, "/help" → help).
 */
export function parseTelegramUpdate(body = {}) {
  const m = body?.message || body?.edited_message;
  if (!m || !m.chat || typeof m.text !== "string") return null;
  let text = m.text.trim();
  // /start and /help are commands, not chat content: keep any payload after
  // them, or fall back to a plain greeting/help word.
  if (/^\/start\b/i.test(text)) { text = text.replace(/^\/start\b\s*/i, "").trim() || "hello"; }
  else if (/^\/help\b/i.test(text)) { text = text.replace(/^\/help\b\s*/i, "").trim() || "help"; }
  if (!text) return null;
  return {
    chatId: String(m.chat.id),                 // may be negative for groups
    text,
    msgId: m.message_id,
    fromId: m.from?.id ? String(m.from.id) : "",
    name: m.from?.first_name || m.chat?.first_name || m.chat?.title || "",
    updateId: body.update_id,
  };
}

/** Convert EDAY's markdown-ish text to Telegram-safe HTML (escapes, **bold**). */
export function toTelegramHtml(text) {
  let s = String(text || "");
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s;
}

async function apiSendMessage(chatId, text, parseMode) {
  const res = await botApi("sendMessage", { chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    let detail = t.slice(0, 200);
    try { const j = JSON.parse(t); detail = `code ${j.error_code}: ${j.description || detail}`; } catch { /* raw */ }
    const e = new Error(`telegram send HTTP ${res.status}: ${detail}`);
    e.status = res.status;
    if (res.status === 403) e.code = 403; // bot blocked / chat gone
    throw e;
  }
  return res.json();
}

/** Default outbound sender: sendMessage with HTML parse (falls back to plain). */
async function apiSender(chatId, text) {
  try {
    return await apiSendMessage(chatId, toTelegramHtml(text), "HTML");
  } catch (e) {
    if (e.status === 400 && /parse|entities|can't parse/i.test(e.message)) {
      log("[telegram] HTML parse rejected — resending plain text");
      return apiSendMessage(chatId, String(text).replace(/\*\*([^*]+)\*\*/g, "$1"), undefined);
    }
    throw e;
  }
}

/** True when the bot can't reach the chat (blocked by user / chat closed). */
export function chatUnreachable(e) {
  return (e && e.code === 403) || /403|bot was blocked|chat not found/i.test(String(e.message || e)) || false;
}

/** Send one text reply, chunked under Telegram's 4096-char cap. */
export async function sendTelegram(chatId, text, sender = apiSender) {
  const body = String(text || "").trim();
  if (!body) return { skipped: true };
  const chunks = [];
  for (let i = 0; i < body.length; i += 4000) chunks.push(body.slice(i, i + 4000));
  if (config.telegramDryRun) {
    log(`[telegram] DRY-RUN to ${chatId}:`, chunks[0].slice(0, 120) + (chunks.length > 1 ? " …" : ""));
    return { dry_run: true, chunks: chunks.length };
  }
  const transient = (e) => /HTTP (429|5\d\d)/.test(e.message || "") || e.name === "TypeError" || e.name === "AbortError";
  let failures = 0;
  for (const c of chunks) {
    for (let attempt = 0; ; attempt++) {
      try { await sender(chatId, c); break; }
      catch (e) {
        failures++;
        if (attempt >= 2 || !transient(e)) { log(`[telegram] SEND FAILED to ${chatId}:`, e.message); throw e; }
        const waitMs = 600 * (attempt + 1);
        log(`[telegram] send retry ${attempt + 1} in ${waitMs}ms (${String(e.message).slice(0, 90)})`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  return { sent: true, chunks: chunks.length, failures };
}

/**
 * Handle one Telegram update → EDAY session → reply. Telegram shows a NATIVE
 * "typing…" bubble while we work (sendChatAction re-fired every ~4s — WhatsApp
 * has no equivalent; Telegram gives it to us for free).
 * Same-chat updates are processed SERIALLY; update_ids are de-duped in-memory
 * (Telegram re-sends an update until we ack with 200).
 */
const chatQueues = new Map();   // chatId -> promise chain
const seenUpdates = new Map();  // updateId -> ms
const DEDUPE_TTL_MS = 10 * 60 * 1000;

export async function handleTelegramUpdate(body = {}, opts = {}) {
  const sender = opts.sender || apiSender;
  const upd = opts.parsed || parseTelegramUpdate(body);
  if (!upd) return { received: 0 };
  if (upd.updateId !== undefined) {
    const now = Date.now();
    if (seenUpdates.size > 1000) for (const [k, t] of seenUpdates) if (now - t > DEDUPE_TTL_MS) seenUpdates.delete(k);
    if (seenUpdates.has(upd.updateId)) { log(`[telegram] duplicate update ${upd.updateId} — skipping`); return { duplicate: true }; }
    seenUpdates.set(upd.updateId, now);
  }
  log(`[telegram] inbound chat=${upd.chatId}${upd.name ? ` [${upd.name}]` : ""}: ${upd.text.slice(0, 100)}`);
  const userId = `tg_${upd.chatId}`;
  const sid = `tg_${upd.chatId}`;
  const run = async () => {
    let typingTimer = null;
    if (!config.telegramDryRun && config.telegramAck) {
      const fire = () => {
        fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendChatAction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: upd.chatId, action: "typing" }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
        typingTimer = setTimeout(fire, 4000); // typing bubble lasts ~5s — re-fire
      };
      fire();
    }
    try {
      const out = await handleMessage({ session_id: sid, user_id: userId, channel: "telegram", message: upd.text });
      if (typingTimer) clearTimeout(typingTimer);
      const sent = await sendTelegram(upd.chatId, out.reply, sender);
      audit.write({ kind: "tg_out", user_id: userId, session: sid, to: upd.chatId, ok: !!sent.sent, ...(sent.failures ? { failures: sent.failures } : {}) });
      return { chatId: upd.chatId, reply: String(out.reply).slice(0, 80), sent: !!sent.sent };
    } catch (e) {
      if (typingTimer) clearTimeout(typingTimer);
      if (chatUnreachable(e)) {
        log(`[telegram] reply to ${upd.chatId} skipped — bot blocked or chat closed`);
        audit.write({ kind: "tg_out", user_id: userId, session: sid, to: upd.chatId, ok: false, expected: "chat_unreachable" });
        return { chatId: upd.chatId, error: "chat_unreachable", expected: true };
      }
      log("[telegram] processing failed:", e.message);
      audit.write({ kind: "tg_out", user_id: userId, session: sid, to: upd.chatId, ok: false, error: String(e.message).slice(0, 200) });
      try { await sendTelegram(upd.chatId, "Sorry, something went wrong on my side. Please try again in a moment.", sender); } catch { /* swallow */ }
      return { chatId: upd.chatId, error: e.message };
    }
  };
  const prev = chatQueues.get(upd.chatId) || Promise.resolve();
  const next = prev.then(run, run);
  chatQueues.set(upd.chatId, next);
  await next;
  return { received: 1 };
}
