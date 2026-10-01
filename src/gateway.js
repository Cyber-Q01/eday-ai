// ---- Gateway to the real backend (ai-actions edge function) ----
//
// TOOL_MODE=http routes every tool through ONE endpoint: the ai-actions edge
// function, guarded by the shared BACKEND_INTERNAL_KEY secret (compared
// constant-time server-side) and the Idempotency-Key header the tools layer
// already generates per run.
//
// This module owns three concerns so nothing else changes:
//   1. AUTH GATE  — resolveUser(channel, externalId) maps a chat handle to the
//      real auth UUID via linked_channels, cached 5 min. No link → no chat.
//   2. TRANSPORT  — callGateway(action, args, …) posts {action, args, user_id,
//      channel} with the secret header; failures normalize to error objects.
//   3. ADAPTERS   — edge results are reshaped into the same shapes the
//      simulated backend returns, so the orchestrator is mode-agnostic
//      (kobo→naira conversions happen HERE, once).
//
// Money rules mirrored from the edge: balances/orders are read LIVE (never
// cached), retries carry a deterministic idempotency key inside a 10-minute
// bucket so a retried confirm can never double-charge (bills.reference /
// orders.reference UNIQUE arbitrate), and every payment still passes the
// orchestrator's in-chat confirm gate BEFORE execution.

import { config } from "./config.js";
import { sha, uid } from "./util.js";
import { log } from "./util.js";

export const gatewayEnabled = () =>
  config.toolMode === "http" && !!config.backendUrl && !!config.backendKey;

// The active channel for the in-flight turn (set by the channel adapters).
// The gateway needs it to prove the "channel not linked" check server-side.
let ACTIVE_CHANNEL = "";
export const setActiveChannel = (ch) => { ACTIVE_CHANNEL = String(ch || ""); };
export const activeChannel = () => ACTIVE_CHANNEL;

// ---------- 1 · auth gate ----------

const linkCache = new Map(); // external_id -> { userId, at }
const LINK_TTL_MS = 5 * 60 * 1000;

/** Map a chat handle to the real user, or null when not linked.
 *  Mock/dev mode (gateway disabled) returns the handle itself so local
 *  testing needs no Supabase. On a gateway ERROR we fail CLOSED — an
 *  unauthenticated conversation must never fall open. */
export async function resolveUser(channel, externalId) {
  if (!gatewayEnabled()) return { linked: true, user_id: externalId, mock: true };
  const key = `${channel}:${externalId}`;
  const hit = linkCache.get(key);
  if (hit && Date.now() - hit.at < LINK_TTL_MS) return hit.userId ? { linked: true, user_id: hit.userId } : { linked: false };
  let out;
  try {
    const r = await callGateway("resolve_user", { channel, external_id: externalId }, { skipUser: true });
    const u = r.result?.user_id;
    out = u ? { linked: true, user_id: u } : { linked: false };
  } catch (e) {
    log("gateway resolve_user failed — failing closed:", e.message);
    out = { linked: false, gatewayDown: true };
  }
  linkCache.set(key, { userId: out.user_id || null, at: Date.now() });
  return out;
}

/** The single reply an unlinked sender ever gets (rate-limited by callers). */
export function notLinkedReply(channel) {
  const name = channel === "whatsapp" ? "WhatsApp number" : "Telegram account";
  return {
    linked: false,
    reply:
      `This ${name} isn't linked to an eday account yet, so I can't help from here.\n` +
      `Open the eday app, go to Account → Channels, and connect — it takes about a minute.\n` +
      (channel === "telegram"
        ? "The app will show you a 4-digit code — just send it to me here and we're done."
        : "As long as it's the same phone number you registered with, linking is automatic."),
  };
}

/** Channels write through on link events — a fresh binding is usable
 *  instantly, no TTL wait. */
export function linkCacheSet(channel, externalId, userId) {
  linkCache.set(`${channel}:${externalId}`, { userId, at: Date.now() });
}

const lastNudge = new Map();
/** One unlinked-sender reply per 10 min per sender — never a reply loop. */
export function shouldNudge(key) {
  const now = Date.now();
  const last = lastNudge.get(key) || 0;
  if (now - last < 10 * 60 * 1000) return false;
  lastNudge.set(key, now);
  if (lastNudge.size > 1000) for (const [k, t] of lastNudge) if (now - t > 30 * 60 * 1000) lastNudge.delete(k);
  return true;
}

// ---------- 2 · transport ----------

/** POST one action to ai-actions. Returns { status, ...body }. */
export async function callGateway(action, args = {}, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    "x-internal-key": config.backendKey,
    "Idempotency-Key": opts.idempotencyKey || `ai-${uid("gw")}`,
  };
  const body = opts.skipUser
    ? { action, args }
    : { action, args, user_id: opts.userId, channel: opts.channel ?? ACTIVE_CHANNEL };
  const res = await fetch(`${config.backendUrl}/ai-actions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text().catch(() => "");
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: "BAD_GATEWAY_RESPONSE" }; }
  return { status: res.status, ...parsed };
}

/** Deterministic idempotency key: identical request retried inside the
 *  10-minute bucket → same key → the backend's UNIQUE reference returns the
 *  original result instead of charging twice. A genuinely new purchase
 *  (later bucket, different args) gets its own key. */
export function idemKeyFor(userId, tool, args = {}) {
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  const material = [userId, tool, bucket, args.amount ?? args.amount_ngn ?? "", args.phone ?? "",
    args.meter_number ?? args.meter ?? "", args.network ?? "", args.plan ?? "", args.disco ?? "",
    args.pickup ?? "", args.destination ?? ""].join("|");
  return `ai${sha(material)}`;
}

// ---------- 3 · adapters (edge result → simulated-backend shape) ----------

const koboToNaira = (k) => Math.round(Number(k || 0) / 100);
const naira = (k) => "₦" + koboToNaira(k).toLocaleString();

function billMessage(kind, b) {
  const amt = naira(b.amount ?? 0);
  if (kind === "electricity") {
    const tok = b.token ? ` Token: ${b.token}${b.units_kwh ? ` (${b.units_kwh} kWh)` : ""}.` : " Your token will appear in the app's Bills page once the vendor confirms.";
    return `${amt} electricity for ${b.customer_ref ?? "your meter"} — done.${tok}`;
  }
  if (kind === "data") return `${amt} ${String(b.network ?? "").toUpperCase()} data sent to ${b.customer_ref ?? ""}. Reference: ${b.reference ?? ""}.`;
  return `${amt} ${String(b.network ?? "").toUpperCase()} airtime sent to ${b.customer_ref ?? ""}. Reference: ${b.reference ?? ""}.`;
}

/** Map an ai-actions response onto exactly the shapes backend.js returns, so
 *  orchestrator.js never learns which mode it is in. Throws nothing: errors
 *  come back as { error, message } like the simulated backend. */
export async function executeViaGateway(name, args, userId, runId) {
  const channel = ACTIVE_CHANNEL || "api";
  let action = name;
  let payload = { ...args };
  let idem = idemKeyFor(userId, name, args);

  // --- argument translation (chat args → edge args) ---
  if (name === "airtime_purchase" || name === "data_purchase" || name === "electricity_purchase") {
    const kind = name === "airtime_purchase" ? "airtime" : name === "data_purchase" ? "data" : "electricity";
    action = name;
    payload = {
      kind, idempotencyKey: idem,
      phone: args.phone ?? "",
      network: args.network ?? "",
      amount: Math.round(Number(args.amount_ngn ?? args.amount ?? 0) * 100), // naira → kobo
      disco: args.disco ?? "",
      meter: args.meter_number ?? "",
      plan: args.plan ?? "",
    };
  }
  if (name === "send_book") {
    payload = {
      reference: `AI${sha(idem).toUpperCase().slice(0, 14)}`,
      pickup: args.pickup ?? "",
      destination: args.destination ?? "",
      lat_from: args.lat_from, lng_from: args.lng_from, lat_to: args.lat_to, lng_to: args.lng_to,
      express: !!args.express,
      category: args.package_type || "Other",
      receiverName: args.receiver_name || "AI booking",
      receiverPhone: args.receiver_phone || "",
    };
  }
  if (name === "send_track") { action = "send_track"; payload = { reference: args.order_ref ?? args.reference ?? "" }; }
  if (name === "order_status") { action = "send_track"; payload = { reference: args.order_ref ?? "" }; }
  if (name === "wallet_balance") { action = "wallet_balance"; payload = {}; }
  if (name === "send_handoff") { idem = `ai-handoff-${runId}`; }

  let r;
  try {
    r = await callGateway(action, payload, { userId, channel, idempotencyKey: idem });
  } catch (e) {
    return { error: "GATEWAY_UNREACHABLE", message: "I couldn't reach the eday backend just now — try again in a moment." };
  }

  const res = r.result ?? {};
  const fail = (error, message) => ({ error, message });

  // --- result translation (edge shapes → mock shapes) ---
  switch (name) {
    case "wallet_balance":
      return { balance: koboToNaira(res.balance) }; // naira integer, like backend.js

    case "send_quote": {
      if (r.status >= 400 || res.error) return fail("NO_RESULTS", res.error || "I couldn't quote that route right now.");
      return {
        success: true,
        quotes: (res.quotes ?? []).map((q) => ({ provider: q.provider, tier: q.tier, amount: koboToNaira(q.amount), eta_minutes: q.eta_minutes })),
        chosen: res.chosen ? { ...res.chosen, amount: koboToNaira(res.chosen.amount) } : undefined,
        currency: "NGN",
        // coords ride along so the booking can go straight to begin_send_order
        coords: { lat_from: res.lat_from, lng_from: res.lng_from, lat_to: res.lat_to, lng_to: res.lng_to },
      };
    }

    case "send_book": {
      if (r.status >= 400 || res.error) {
        if (/insufficient|balance/i.test(String(res.error ?? ""))) return fail("INSUFFICIENT_FUNDS", "Your wallet balance is too low for this delivery — top up first.");
        return fail("BOOKING_FAILED", res.error || "The delivery could not be booked — try again.");
      }
      return {
        success: true,
        idempotent: !!res.idempotent,
        order: { id: res.order_id, status: res.status, vertical: "send", amount: koboToNaira(res.amount) },
        message: res.message || "Delivery booked.",
      };
    }

    case "send_track":
    case "order_status": {
      if (r.status === 404 || res.error === "NOT_FOUND") return fail("NOT_FOUND", "No delivery with that reference on this account.");
      if (r.status >= 400 || res.error) return fail("TRACK_FAILED", "Tracking is unavailable right now — try again.");
      return {
        order_id: res.order_id, vertical: res.vertical, status: res.status, amount: res.amount,
        last_event: { note: `${res.route ?? ""}${res.eta_minutes ? ` · ETA ~${res.eta_minutes} min` : ""}`.trim() || "Status updated" },
      };
    }

    case "bill_validate":
      return r.status >= 400 || res.error ? fail("METER_NOT_FOUND", res.error || "That meter could not be verified.") : { success: true, ...res };

    case "airtime_purchase":
    case "data_purchase":
    case "electricity_purchase": {
      if (r.status === 402) return fail("INSUFFICIENT_FUNDS", "Your wallet balance is too low — top up first, then ask me to retry.");
      if (r.status === 429) return fail("RATE_LIMITED", "Too many purchases in a row — try again in a little while.");
      if (r.status >= 400 || res.error) return fail("VEND_FAILED", res.error || "The purchase did not go through — nothing was charged.");
      const bill = res.bill ?? {};
      if (res.status === "processing" || bill.status === "pending") {
        return { success: true, status: "PENDING", ref: bill.reference, message: "The vendor is still processing this — you will not lose money either way. Check the app's Bills page in a moment." };
      }
      return { success: true, ref: bill.reference, status: "COMPLETED", message: billMessage(name === "airtime_purchase" ? "airtime" : name === "data_purchase" ? "data" : "electricity", bill) };
    }

    case "send_handoff":
      return r.status >= 400 || res.error ? fail("HANDOFF_FAILED", "I couldn't prepare the app handoff — we can finish right here instead.") : { success: true, deeplink: res.deeplink, token: res.token, expires_at: res.expires_at };

    default:
      return res;
  }
}
