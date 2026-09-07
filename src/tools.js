// ---- Tool layer: registry with permissions + confirmation rules + execution.
//      Every tool maps 1:1 to a backend action (simulated now, real later). ----

import { config } from "./config.js";
import * as backend from "./backend.js";
import { log, uid, nowIso } from "./util.js";

export const PAYMENT_TOOLS = new Set([
  "airtime_purchase", "data_purchase", "electricity_purchase", "send_book", "ride_book", "stay_book",
  "chop_order", "shop_order", "wallet_topup_start",
]);

export const toolDefs = [
  { name: "wallet_balance", permission: "read", vertical: "wallet", desc: "Current wallet balance" },
  { name: "wallet_topup_start", permission: "confirm_each", vertical: "wallet", desc: "Start wallet top-up (card link)" },
  { name: "airtime_purchase", permission: "confirm_each", vertical: "bills", desc: "Buy airtime (network, phone, amount)" },
  { name: "data_purchase", permission: "confirm_each", vertical: "bills", desc: "Buy data bundle (network, phone, amount)" },
  { name: "electricity_purchase", permission: "confirm_each", vertical: "bills", desc: "Pay electricity (disco, meter, amount)" },
  { name: "send_quote", permission: "read", vertical: "send", desc: "Quote package delivery (pickup, destination)" },
  { name: "send_book", permission: "confirm_each", vertical: "send", desc: "Book a courier for a quoted price" },
  { name: "send_track", permission: "read", vertical: "send", desc: "Track a send order" },
  { name: "order_status", permission: "read", vertical: "core", desc: "Status of any order by ref" },
  { name: "ride_quote", permission: "read", vertical: "ride", desc: "Quote a ride (pickup, destination)" },
  { name: "ride_book", permission: "confirm_each", vertical: "ride", desc: "Book a ride" },
  { name: "stay_search", permission: "read", vertical: "stay", desc: "Search stays (city, nights)" },
  { name: "stay_book", permission: "confirm_each", vertical: "stay", desc: "Book a stay by property id" },
  { name: "chop_order", permission: "confirm_each", vertical: "chop", desc: "Order food" },
  { name: "shop_order", permission: "confirm_each", vertical: "shop", desc: "Order products" },
  { name: "work_request", permission: "confirm_each", vertical: "work", desc: "Create a work service request" },
  { name: "support_ticket", permission: "read", vertical: "core", desc: "Create a support ticket" },
  { name: "help_menu", permission: "read", vertical: "core", desc: "Show what EDAY AI can do" },
];

export function findTool(name) {
  return toolDefs.find((t) => t.name === name) || null;
}

export function isPaymentTool(name) {
  return PAYMENT_TOOLS.has(name);
}

export function needsConfirm(name) {
  if (config.skipConfirm) return false;
  const def = findTool(name);
  return def ? def.permission === "confirm_each" : false;
}

/** Build the confirmation prompt text for a payment tool + args (server-side, no raw args echoed). */
export function confirmationText(name, args = {}, ctx = {}) {
  const amt = args.amount_ngn ?? args.amount ?? args.fare ?? args.total ?? 0;
  const pieces = {
    airtime_purchase: `Buy ₦${amt?.toLocaleString?.() ?? amt} airtime for ${args.network || "?"} (${args.phone || "?"})?`,
    data_purchase: `Buy ₦${amt} data bundle for ${args.network || "?"} (${args.phone || "?"})?`,
    electricity_purchase: `Pay ₦${amt}${args.disco ? " " + args.disco : ""} electricity for meter ${args.meter_number || "?"}?`,
    send_book: `Book courier ${args.provider || ""} for ₦${amt} (${args.pickup || ""} → ${args.destination || ""})?`,
    ride_book: `Book ${args.ride_type || "Car"} for ₦${amt} (${args.pickup || ""} → ${args.destination || ""})?`,
    stay_book: `Book ${args.property_name || "this stay"} for ₦${amt}?`,
    chop_order: `Place food order for ₦${amt}?`,
    shop_order: `Place shop order for ₦${amt}?`,
    work_request: `Create work request for ₦${amt}?`,
    wallet_topup_start: `Start a wallet top-up of ₦${amt}?`,
  };
  return pieces[name] || `Confirm this action?`;
}

// ---------- execution ----------
export async function executeTool(name, args, userId, runId) {
  const def = findTool(name);
  if (!def) return { error: "UNKNOWN_TOOL", message: `Unknown tool ${name}` };
  log(`tool: run=${runId} user=${userId} tool=${name} args=${JSON.stringify(args)}`);

  const started = Date.now();
  let result;
  let status = "ok";
  try {
    if (config.toolMode === "http" && config.backendInternalUrl && backend.actions[name] === undefined) {
      // real-backend mode (later): POST to backend action endpoint with idempotency key
      const res = await fetch(`${config.backendInternalUrl}/functions/v1/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.backendInternalKey}`, "Idempotency-Key": `ai-${runId}-${name}` },
        body: JSON.stringify(args),
      });
      result = await res.json();
    } else {
      const fn = backend.actions[name];
      if (!fn) result = { error: "UNAVAILABLE", message: `${name} is not available yet.` };
      else result = fn(userId, args || {});
    }
    if (result && result.error) status = "error";
  } catch (e) {
    status = "error";
    result = { error: "INTERNAL", message: e.message || "Unexpected error" };
  }
  return { name, status, latency_ms: Date.now() - started, ...result };
}
