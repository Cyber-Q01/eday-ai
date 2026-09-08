// ---- WhatsApp Cloud API (Meta) bridge ---------------------------------------
// Makes EDAY AI reachable from a real WhatsApp number:
//   GET  /webhook/whatsapp  → Meta verification handshake (hub.challenge)
//   POST /webhook/whatsapp  → incoming messages → handleMessage() → reply via
//                             Graph API (user-initiated 24h session, freeform).
// Each WhatsApp sender becomes an EDAY user ("wa_<number>") with a sticky
// session, so memory + confirmations persist across their messages.
//
// Config (env): WHATSAPP_VERIFY_TOKEN (required) · WHATSAPP_TOKEN · WHATSAPP_PHONE_ID
//               WHATSAPP_APP_SECRET (optional signature check) · WHATSAPP_DRY_RUN
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { log } from "./util.js";
import { handleMessage } from "./orchestrator.js";

export function whatsappEnabled() {
  return Boolean(config.whatsappVerifyToken);
}

export function whatsappReady() {
  return whatsappEnabled() && Boolean(config.whatsappToken && config.whatsappPhoneId);
}

/** Meta webhook verification: ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… */
export function verifyHandshake(url) {
  const p = url.searchParams;
  if (p.get("hub.mode") !== "subscribe") return null;
  if (p.get("hub.verify_token") !== config.whatsappVerifyToken) return null;
  const challenge = p.get("hub.challenge");
  return challenge ? String(challenge) : null;
}

/** Optional X-Hub-Signature-256 check using the app secret (raw body!). */
export function signatureOk(rawBody, header) {
  if (!config.whatsappAppSecret) return true; // not configured → skip (log once in route)
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", config.whatsappAppSecret).update(rawBody).digest("hex");
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Default sender: Graph API messages endpoint. */
async function graphSender(to, text) {
  const url = `https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.whatsappToken}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`whatsapp send HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

/** Send one text reply (chunked if > 4000 chars — WhatsApp limit). */
export async function sendWhatsApp(to, text, sender = graphSender) {
  const body = String(text || "").trim();
  if (!body) return { skipped: true };
  const chunks = [];
  for (let i = 0; i < body.length; i += 3900) chunks.push(body.slice(i, i + 3900));
  if (config.whatsappDryRun) {
    log(`[whatsapp] DRY-RUN to ${to}:`, chunks[0].slice(0, 120) + (chunks.length > 1 ? " …" : ""));
    return { dry_run: true, chunks: chunks.length };
  }
  for (const c of chunks) await sender(to, c);
  return { sent: true, chunks: chunks.length };
}

/** Extract WhatsApp messages from a Cloud API webhook payload. */
export function extractMessages(body = {}) {
  const out = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const m of v.messages || []) {
        if (m.type === "text") out.push({ from: m.from, text: String(m.text?.body || ""), id: m.id });
        // quick-reply buttons ("yes"/"no"/"1"…) arrive as interactive replies
        else if (m.type === "interactive" && m.interactive?.type === "button_reply") {
          out.push({ from: m.from, text: String(m.interactive.button_reply?.title || m.interactive.button_reply?.id || ""), id: m.id });
        }
        // list replies (e.g. picking a stay option) behave like text too
        else if (m.type === "interactive" && m.interactive?.type === "list_reply") {
          out.push({ from: m.from, text: String(m.interactive.list_reply?.title || m.interactive.list_reply?.id || ""), id: m.id });
        }
      }
    }
  }
  return out;
}

/**
 * Handle one webhook payload: each inbound message → EDAY session → reply.
 * The same sender always maps to the same user/session ("wa_<from>").
 * Messages from one sender are processed SERIALLY (a WhatsApp user can fire
 * several messages before the LLM answers the first — "yes" must land after
 * the confirm it refers to, never before).
 */
const senderQueues = new Map(); // from -> promise chain

export async function handleWhatsappPayload(body, opts = {}) {
  const sender = opts.sender || graphSender;
  const messages = extractMessages(body);
  const results = [];
  for (const m of messages) {
    if (!m.text) { results.push({ skipped: true }); continue; }
    const userId = `wa_${m.from}`;
    const sid = `wa_${m.from}`;
    const run = async () => {
      try {
        const out = await handleMessage({ session_id: sid, user_id: userId, channel: "whatsapp", message: m.text });
        await sendWhatsApp(m.from, out.reply, sender);
        return { from: m.from, reply: String(out.reply).slice(0, 80) };
      } catch (e) {
        log("[whatsapp] processing failed:", e.message);
        try { await sendWhatsApp(m.from, "Sorry, something went wrong on my side. Please try again in a moment.", sender); } catch { /* swallow */ }
        return { from: m.from, error: e.message };
      }
    };
    // chain onto this sender's queue so bursts stay in order
    const prev = senderQueues.get(m.from) || Promise.resolve();
    const next = prev.then(run, run);
    senderQueues.set(m.from, next);
    results.push(next);
  }
  const settled = await Promise.all(results);
  return {
    received: messages.length,
    replied: settled.filter((r) => r && r.reply).length,
    replies: settled.filter((r) => r && (r.reply || r.error)),
  };
}
