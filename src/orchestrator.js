// ---- Core chat orchestration loop ----
// user message → session state → intent (LLM or mock) → context/memory → act:
//   single tool (with confirm gate for payments)  OR  multi-step plan (travel etc.)
// confirmations are stateful per session (awaiting_confirm) and resume on "yes".

import { effectiveLlmMode, isMock } from "./config.js";
import { mockClassifyIntent } from "./mockIntent.js";
import { llmClassifyIntent, llmPlan } from "./llm.js";
import { executeTool, needsConfirm, confirmationText, toolDefs, isPaymentTool } from "./tools.js";
import { memory } from "./memory.js";
import { audit } from "./audit.js";
import { fmtNgn, maskPhone, maskMeter, log, nowIso, uid } from "./util.js";

const sessions = new Map(); // sessionId -> state

function getSession(sessionId, userId, channel) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId, userId, channel: channel || "api", createdAt: nowIso(),
      history: [],                 // [{role, content}]
      pendingConfirm: null,        // {kind:'tool', name, args, text, ref} | {kind:'plan', steps, text, ref}
      plan: null,                  // {id, steps:[{tool,args,confirm,status,result}], cursor}
      prefsPrompted: false,
    });
  }
  return sessions.get(sessionId);
}

function summarizeEntities(e = {}) {
  const out = { ...e };
  if (out.phone) out.phone = maskPhone(out.phone);
  if (out.meter_number) out.meter_number = maskMeter(out.meter_number);
  return out;
}

function friendlyError(e) {
  if (!e) return "Sorry, something went wrong. Try again.";
  if (e.error === "INSUFFICIENT_FUNDS") return e.message + " You can say “top up ₦5000” to add money, then I'll retry.";
  if (e.error === "METER_NOT_FOUND" || e.error === "INVALID_PHONE" || e.error === "INVALID_AMOUNT" ||
      e.error === "UNKNOWN_NETWORK" || e.error === "DISCO_MISMATCH" || e.error === "MISSING_ADDRESS" ||
      e.error === "NO_RESULTS" || e.error === "NOT_FOUND" || e.error === "MISSING_QUOTE")
    return e.message;
  return e.message || "Sorry, that didn't work. Please try again.";
}

// ---------- intent resolution ----------
async function resolveIntent(text, session) {
  if (isMock()) {
    const m = normalizeIntent(mockClassifyIntent(text));
    audit.write({ kind: "intent", mode: "mock", user_id: session.userId, session: session.id, ...m, entities: summarizeEntities(m.entities) });
    return m;
  }
  try {
    const tail = session.history.slice(-4).map((h) => `${h.role}: ${String(h.content).slice(0, 200)}`).join("\n");
    const m = normalizeIntent(await llmClassifyIntent(text, tail));
    // LLMs often label concrete requests phrased as questions as "help"
    // (e.g. "what do I need to give you to send a package to Ikeja?").
    // If so, and the rule parser finds a REAL service signal, prefer it.
    if (["help", "greeting", "offscope"].includes(m.intent)) {
      const r = normalizeIntent(mockClassifyIntent(text));
      const concrete = r && ["service_request", "track", "wallet", "support"].includes(r.intent);
      const bareHelp = /^\s*(help|menu|what can you do|what do you do)\s*$/i.test(text);
      if (concrete && !bareHelp) {
        log(`intent '${m.intent}' refined → ${r.vertical}/${r.subtype} (text has concrete service signal)`);
        audit.write({ kind: "intent", mode: "refined", user_id: session.userId, session: session.id, ...r, entities: summarizeEntities(r.entities) });
        return r;
      }
    }
    audit.write({ kind: "intent", mode: "openai", model: m._model, user_id: session.userId, session: session.id,
      intent: m.intent, vertical: m.vertical, subtype: m.subtype, confidence: m.confidence, multi: m.multi,
      entities: summarizeEntities(m.entities), needs_clarification: m.needs_clarification });
    return m;
  } catch (e) {
    log("llm intent failed, falling back to mock:", e.message);
    const m = normalizeIntent(mockClassifyIntent(text));
    audit.write({ kind: "intent", mode: "fallback", user_id: session.userId, session: session.id, ...m, entities: summarizeEntities(m.entities) });
    return m;
  }
}

// ---------- intent normalization ----------
// LLMs sometimes return vertical "none"/null while still giving a real subtype
// (e.g. subtype:"airtime", vertical:"none"). Repair the vertical from the subtype
// so the intent → tool mapper never dead-ends on schema drift.
function normalizeIntent(m) {
  const i = m || {};
  if (!i.vertical || i.vertical === "none") {
    const map = {
      airtime: "bills", data: "bills", electricity: "bills",
      send_package: "send", send_track: "send", ride_now: "ride",
      stay_book: "stay", travel: "stay", chop_order: "chop",
      shop_order: "shop", work_request: "work",
    };
    if (map[i.subtype]) i.vertical = map[i.subtype];
  }
  return i;
}

// ---------- intent → concrete tool call ----------
function mapIntentToCall(intent) {
  const sub = intent.subtype;
  const e = intent.entities || {};
  if (intent.vertical === "bills") {
    if (sub === "airtime") return { name: "airtime_purchase", args: { network: e.network || "mtn", phone: e.phone, amount_ngn: e.amount_ngn }, missing: missingOf(e, ["phone", "amount_ngn"]) };
    if (sub === "data") return { name: "data_purchase", args: { network: e.network || "mtn", phone: e.phone, amount_ngn: e.amount_ngn }, missing: missingOf(e, ["phone", "amount_ngn"]) };
    if (sub === "electricity") return { name: "electricity_purchase", args: { disco: e.disco, meter_number: e.meter_number, amount_ngn: e.amount_ngn }, missing: missingOf(e, ["meter_number", "amount_ngn"]) };
  }
  if (intent.vertical === "send" && sub === "send_package") {
    const args = { pickup: e.pickup || inferPickup(e.description || "") || "", destination: e.destination || "", package_type: e.package_type };
    return { name: "send_quote", args, missing: missingOf(args, ["pickup", "destination"]) };
  }
  if (intent.vertical === "ride" && sub === "ride_now") {
    const args = { pickup: e.pickup || inferPickup(e.description || ""), destination: e.destination || "", ride_type: null };
    return { name: "ride_quote", args, missing: missingOf(args, ["pickup", "destination"]) };
  }
  if (intent.vertical === "stay" && (sub === "stay_book" || sub === "travel"))
    return { name: "stay_search", args: { city: e.city || guessCity(e.description), nights: e.nights || 1 }, missing: [] };
  // CHOP — food delivery
  if (intent.vertical === "chop" && sub === "chop_order")
    return { name: "chop_order", args: { city: e.city || guessCity(e.description), description: e.description || "" }, missing: missingOf(e, ["description"]) };
  // SHOP — commerce
  if (intent.vertical === "shop" && sub === "shop_order")
    return { name: "shop_order", args: { description: e.description || "" }, missing: missingOf(e, ["description"]) };
  // WORK — gigs/services
  if (intent.vertical === "work" && sub === "work_request")
    return { name: "work_request", args: { description: e.description || "", city: e.city || guessCity(e.description) }, missing: missingOf(e, ["description"]) };
  if (intent.intent === "wallet" && sub === "topup")
    return { name: "wallet_topup_start", args: { amount_ngn: e.amount_ngn }, missing: missingOf(e, ["amount_ngn"]) };
  if (intent.intent === "wallet") return { name: "wallet_balance", args: {}, missing: [] };
  if (intent.intent === "track") {
    const ref = e.order_ref || extractRef(e.description || "");
    return { name: "order_status", args: { order_ref: ref }, missing: ref ? [] : ["order_ref"] };
  }
  if (intent.intent === "help") return { name: "help_menu", args: {}, missing: [] };
  if (intent.intent === "support") return { name: "support_ticket", args: { description: intent.entities?.description }, missing: [] };
  return null;
}

function missingOf(e, keys) {
  return keys.filter((k) => !e[k]);
}
function inferPickup(desc = "") {
  const m = desc.match(/from\s+([A-Za-z0-9 ,-]{3,40}?)(?:\s+to|\s*$)/i);
  return m ? m[1].trim() : "";
}
function extractRef(desc = "") {
  const m = desc.match(/\b(ORD|BK|VT|EC)_?[A-Za-z0-9]+\b/i);
  return m ? m[0].replace("_", "_") : "";
}
function guessCity(desc = "") {
  const cities = ["abuja", "lagos", "ibadan", "ph", "port harcourt", "kaduna", "kano", "owerri", "enugu", "benin"];
  const hit = cities.find((c) => desc.toLowerCase().includes(c));
  if (hit === "ph" || hit === "port harcourt") return "Port Harcourt";
  return hit ? hit[0].toUpperCase() + hit.slice(1) : "Abuja";
}

function isTravelIntent(intent) {
  return intent.vertical === "stay" && intent.subtype === "travel";
}

// ---------- ask for missing info ----------
function askMissing(call) {
  const label = {
    phone: "the recipient's phone number",
    amount_ngn: "the amount",
    meter_number: "the meter number",
    destination: "the destination address",
    disco: "the electricity provider (e.g. ibedc)",
    order_ref: "your order/reference ID",
    pickup: "the pickup address",
    description: "what you'd like (e.g. \"jollof rice and chicken\", \"a plumber\", \"a smartwatch\")",
  };
  return `Almost there — I need ${call.missing.map((m) => label[m] || m).join(" and ")}.`;
}

// ---------- reply assembly ----------
async function attachMemory(session, intentText) {
  const mem = await memory.recall(session.userId);
  const useful = [];
  for (const p of mem.prefs) {
    const kw = { "default_airtime_phone": "airtime", "default_network": "airtime", "default_meter": "electricity", "home_address": "pick me up|ride|send" };
    for (const [k, v] of Object.entries(kw)) {
      if (p.key === k && intentText.toLowerCase().includes(v)) useful.push(p);
    }
  }
  return useful.length ? useful : null;
}

// ---------- the main entry point ----------
export async function handleMessage({ session_id, user_id, channel, message, context }) {
  const sid = session_id || uid("ses");
  const session = getSession(sid, user_id || "guest", channel);
  session.history.push({ role: "user", content: message });
  if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

  // 1) pending confirmation → interpret reply
  if (session.pendingConfirm) {
    const yes = /^(yes|yeah|yep|ok|okay|sure|go ahead|confirm|pay|approve|done)\b/i.test(message.trim());
    const no = /^(no|nope|cancel|stop|don't|dont|never mind)\b/i.test(message.trim());
    if (yes) return resumeConfirmed(session, sid);
    if (no) {
      const was = session.pendingConfirm;
      session.pendingConfirm = null;
      if (was.kind === "plan") session.plan = null;
      session.history.push({ role: "assistant", content: "Cancelled — nothing was charged." });
      audit.write({ kind: "confirm", action: "declined", user_id: session.userId, session: sid, ref: was.ref });
      return reply(session, sid, "❌ Cancelled — nothing was charged. Is there anything else I can help with?");
    }
    // ambiguous while waiting
    session.history.pop(); // don't store this as regular user turn yet
    return reply(session, sid, `Please reply **Yes** to confirm or **No** to cancel.\n\n${session.pendingConfirm.text}`);
  }

  // 1b) quick replies from quote flows (no pending confirm yet): book the quoted send,
  //     pick a stay result number, choose a ride type
  const qa = handleQuickAction(session, sid, message);
  if (qa) return qa;

  // bare acknowledgements with nothing pending should not fall through to "help"
  if (/^\s*(yes|yeah|yep|ok|okay|sure|no|nope|fine)\s*[.!]*\s*$/i.test(message)) {
    session.history.pop();
    return reply(session, sid, "There's nothing waiting for your confirmation right now. What would you like to do? Try “help” to see everything EDAY can do.");
  }

  // 2) intent
  const intent = await resolveIntent(message, session);

  if (intent.intent === "greeting") {
    const mem = await memory.recall(session.userId);
    const hi = mem.prefs?.length ? `Welcome back! 👋 You have ${mem.prefs.length} saved ${mem.prefs.length === 1 ? "preference" : "preferences"}.` : "Hello! 👋";
    return reply(session, sid, `${hi} I'm the EDAY assistant — I can buy airtime & data, pay electricity bills, send packages, book rides and stays, and more. Try “help” to see what I can do.`, helpActions());
  }

  if (intent.intent === "offscope") {
    audit.write({ kind: "offscope", user_id: session.userId, session: sid, text: message.slice(0, 200) });
    return reply(session, sid, "I can only help with EDAY services (airtime, data, electricity, send, ride, stay, chop, shop, work, wallet). For anything else, contact support via the app.");
  }

  if (intent.intent === "help" || intent.subtype === "none" && !intent.vertical) {
    const t = await executeTool("help_menu", {}, session.userId, uid("run"));
    return reply(session, sid, t.message, helpActions());
  }

  // travel / multi-service plans get the orchestrator treatment
  if (isTravelIntent(intent)) {
    return runPlan(session, sid, message, intent);
  }

  // 3) single tool
  const call = mapIntentToCall(intent);
  if (!call) {
    return reply(session, sid, "I didn't catch that. Could you rephrase? For example: “buy ₦500 MTN airtime for 08031234567” or “send a package from Ikeja to Yaba”.");
  }
  if (call.missing.length) {
    const prefs = await fillFromPrefs(session, call);
    if (prefs) return prefs;
    return reply(session, sid, askMissing(call));
  }

  // quote-style tools: read, then offer the paid follow-up
  if (call.name === "send_quote") {
    const r = await executeTool("send_quote", call.args, session.userId, uid("run"));
    if (r.error) return reply(session, sid, friendlyError(r));
    const best = r.chosen;
    session.lastQuote = { provider: best.provider, amount: best.amount, eta_minutes: best.eta_minutes, pickup: call.args.pickup, destination: call.args.destination };
    return reply(session, sid,
      `Here are delivery quotes for **${call.args.pickup} → ${call.args.destination}**:\n` +
      r.quotes.map((q) => `• ${q.provider} (${q.tier}): ${fmtNgn(q.amount)} · ~${q.eta_minutes} min`).join("\n") +
      `\n\nBest price: **${best.provider} at ${fmtNgn(best.amount)}**. Shall I book it? (reply “book it” or “yes”)`,
      [{ id: "book", title: "Book it" }, { id: "no", title: "No thanks" }]);
  }

  if (call.name === "ride_quote") {
    const r = await executeTool("ride_quote", call.args, session.userId, uid("run"));
    if (r.error) return reply(session, sid, friendlyError(r));
    session.lastRide = { pickup: call.args.pickup, destination: call.args.destination, rides: r.rides };
    return reply(session, sid,
      `🚗 ${call.args.pickup} → ${call.args.destination} (${r.distance_km} km, ~${r.duration_min} min):\n` +
      r.rides.map((x) => `• ${x.type}: ${fmtNgn(x.fare)}`).join("\n") +
      `\n\nWhich would you like? (reply e.g. “book the Car”)`,
      r.rides.map((x) => ({ id: "ride_" + x.type.toLowerCase(), title: `${x.type} · ${fmtNgn(x.fare)}` })));
  }

  if (call.name === "stay_search") {
    const r = await executeTool("stay_search", call.args, session.userId, uid("run"));
    if (r.error) return reply(session, sid, friendlyError(r));
    session.stayResults = r.results;
    const cityDisp = String(call.args.city || "").replace(/^./, (c) => c.toUpperCase());
    return reply(session, sid,
      `🏨 Stays in **${cityDisp}** for ${call.args.nights} night(s):\n` +
      r.results.map((s, i) => `${i + 1}. ${s.name} — ${fmtNgn(s.price_per_night)}/night · ⭐ ${s.rating}`).join("\n") +
      `\n\nReply with the number (1-${r.results.length}) to book, or say “no thanks”.`,
      r.results.map((s, i) => ({ id: "stay_" + (i + 1), title: `${i + 1}. ${s.name.split(" ").slice(0, 2).join(" ")}` })));
  }

  if (call.name === "wallet_balance") {
    const r = await executeTool("wallet_balance", {}, session.userId, uid("run"));
    return reply(session, sid, `💰 Your EDAY wallet balance is **${fmtNgn(r.balance)}**.`);
  }

  if (call.name === "order_status") {
    const r = await executeTool("order_status", call.args, session.userId, uid("run"));
    if (r.error) return reply(session, sid, friendlyError(r));
    return reply(session, sid, `📦 Order ${r.order_id} [${r.vertical}] is **${r.status.replace(/_/g, " ")}**.\nLatest: ${r.last_event.note}`);
  }

  if (call.name === "support_ticket") {
    const r = await executeTool("support_ticket", call.args, session.userId, uid("run"));
    return reply(session, sid, r.message);
  }

  // payment tools → confirm gate
  if (needsConfirm(call.name)) {
    return askConfirm(session, sid, call);
  }

  const r = await executeTool(call.name, call.args, session.userId, uid("run"));
  if (r.error) return reply(session, sid, friendlyError(r));
  return reply(session, sid, r.message || "Done.");
}

function handleQuickAction(session, sid, message) {
  const m = message.trim().toLowerCase();
  if (!m) return null;
  // Book the previously quoted courier
  if (session.lastQuote && /\b(book|yes|book it|book this|go ahead|proceed)\b/.test(m) && !/\bno\b/.test(m)) {
    const q = session.lastQuote;
    session.lastQuote = null;
    return askConfirm(session, sid, {
      name: "send_book",
      args: { pickup: q.pickup, destination: q.destination, provider: q.provider, amount: q.amount, eta_minutes: q.eta_minutes, package_type: q.package_type },
      missing: [],
    });
  }
  // Pick a stay result by number (or plain "yes"/"ok" = pick the first)
  if (session.stayResults && (/^(\d{1,2})$/.test(m) || /\b(yes|yeah|yep|ok|okay|go ahead|proceed|book)\b/.test(m))) {
    const idx = (/^(\d{1,2})$/.test(m) ? parseInt(m, 10) : 1) - 1;
    const s = session.stayResults[idx];
    if (!s) return reply(session, sid, `Pick a number between 1 and ${session.stayResults.length}.`);
    session.stayResults = null;
    return askConfirm(session, sid, { name: "stay_book", args: { property_id: s.id, nights: s.nights, property_name: s.name, amount: s.total_ngn || s.price_per_night * s.nights }, missing: [] });
  }
  // Book a ride of a type shown in the last quote ("yes"/"ok" = Car, the default)
  if (session.lastRide && /\b(book|yes|yeah|yep|ok|okay|go ahead|proceed)\b/.test(m) && !/\bno\b/.test(m)) {
    const type = (m.match(/\b(bike|car|premium)\b/) || [])[1] || "car";
    const r = session.lastRide;
    session.lastRide = null;
    const ride = (r.rides || []).find((x) => x.type.toLowerCase() === type) || (r.rides || [])[1] || { fare: 0 };
    return askConfirm(session, sid, { name: "ride_book", args: { pickup: r.pickup, destination: r.destination, ride_type: type, amount: ride.fare }, missing: [] });
  }
  // polite decline after a quote
  if (/\b(no thanks|not now|no thank you|later)\b/.test(m)) {
    session.lastQuote = null; session.stayResults = null; session.lastRide = null;
    session.history.push({ role: "assistant", content: "No problem. Anything else?" });
    return { session_id: sid, reply: "No problem. Anything else I can help with?", actions: [] };
  }
  return null;
}

function reply(session, sid, text, actions = []) {  session.history.push({ role: "assistant", content: text });
  return { session_id: sid, reply: text, actions, pending_confirm: !!session.pendingConfirm };
}

function helpActions() {
  return [
    { id: "airtime", title: "📱 Airtime" },
    { id: "data", title: "🌐 Data" },
    { id: "electricity", title: "⚡ Electricity" },
    { id: "send", title: "📦 Send" },
    { id: "ride", title: "🚗 Ride" },
    { id: "stay", title: "🏨 Stay" },
    { id: "wallet", title: "💰 Balance" },
  ];
}

function askConfirm(session, sid, call) {
  const text = confirmationText(call.name, call.args) + "\n\nReply **Yes** to confirm, **No** to cancel.";
  session.pendingConfirm = { kind: "tool", name: call.name, args: call.args, text, ref: uid("cf") };
  session.history.push({ role: "assistant", content: text });
  audit.write({ kind: "confirm", action: "requested", user_id: session.userId, session: sid, ref: session.pendingConfirm.ref, tool: call.name, args_summary: summarizeEntities(call.args) });
  return { session_id: sid, reply: text, actions: [{ id: "yes", title: "✅ Yes, pay" }, { id: "no", title: "❌ No" }], pending_confirm: true, ref: session.pendingConfirm.ref };
}

async function resumeConfirmed(session, sid) {
  const pc = session.pendingConfirm;
  session.pendingConfirm = null;
  audit.write({ kind: "confirm", action: "approved", user_id: session.userId, session: sid, ref: pc.ref, tool: pc.name });
  if (pc.kind === "tool") {
    const r = await executeTool(pc.name, pc.args, session.userId, uid("run"));
    if (r.error) return reply(session, sid, friendlyError(r));
    // capture as a preference signal once per session (never for payments)
    await maybeLearnPref(session, pc.name, pc.args);
    // episodic + vector memory of what was done
    try {
      const summary = `${pc.name}: ${String(r.message || "").slice(0, 160)}`;
      await memory.addEpisode(session.userId, summary);
    } catch { /* never break the reply on memory */ }
    return reply(session, sid, `✅ ${r.message}`);
  }
  if (pc.kind === "plan") return runPlanSteps(session, sid);
  return reply(session, sid, "OK.");
}

async function maybeLearnPref(session, tool, args) {
  if (session.prefsPrompted) return;
  session.prefsPrompted = true;
  try {
    if (tool === "airtime_purchase" && args.phone) await memory.addPreference(session.userId, "default_airtime_phone", args.phone);
    if (tool === "airtime_purchase" && args.network) await memory.addPreference(session.userId, "default_network", args.network);
    if (tool === "electricity_purchase" && args.meter_number) await memory.addPreference(session.userId, "default_meter", args.meter_number);
  } catch (e) { /* never break the reply on memory */ }
}

async function fillFromPrefs(session, call) {
  let mem = null;
  try { mem = await memory.recall(session.userId); } catch { /* memory must never crash the reply path */ }
  if (!mem || !Array.isArray(mem.prefs) || !mem.prefs.length) return null;
  const map = { phone: "default_airtime_phone", network: "default_network", meter_number: "default_meter" };
  for (const key of [...call.missing]) {
    const prefKey = map[key];
    if (!prefKey) continue;
    const pref = mem.prefs.find((p) => p.key === prefKey);
    if (!pref) continue;
    call.args[key] = key === "network" ? pref.value : key === "meter_number" ? pref.value : pref.value;
    call.missing = call.missing.filter((m) => m !== key);
  }
  if (call.missing.length) return null;
  const verb = call.name.includes("electricity") ? "your saved meter" : "your saved details";
  return reply(session, session.id, `Use ${verb}? (${Object.entries(call.args).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ")}) — say **Yes** to continue or tell me new details.`);
}

// ---------------- multi-step plan (travel etc.) ----------------
async function runPlan(session, sid, message, intent) {
  const steps = planForTravel(intent, session);
  const text =
    `✈️ I can arrange your trip to **${intent.entities.city || guessCity(intent.entities.description || message)}** in ${intent.entities.nights || 1} night(s). Here's the plan:\n` +
    steps.map((s, i) => `${i + 1}. ${s.label}`).join("\n") +
    `\n\nTotal estimate: **${fmtNgn(steps.reduce((a, s) => a + s.amount, 0))}**\nShall I proceed? (reply **Yes**)`;
  session.pendingConfirm = { kind: "plan", text, ref: uid("pl"), steps };
  audit.write({ kind: "plan", action: "proposed", user_id: session.userId, session: sid, steps: steps.map((s) => s.tool) });
  return reply(session, sid, text, [{ id: "yes", title: "✅ Yes, book all" }, { id: "no", title: "❌ No" }]);
}

function planForTravel(intent, session) {
  const city = intent.entities.city || guessCity(intent.entities.description || "");
  const nights = intent.entities.nights || 1;
  const steps = [];
  steps.push({ tool: "stay_search", args: { city, nights }, label: `Search stays in ${city}`, amount: 0 });
  return steps;
}

async function runPlanSteps(session, sid) {
  const pc = session.pendingConfirm;
  session.pendingConfirm = null;
  // simplified: for travel we do stay_search → pick first hotel → confirm booking separately
  const r = await executeTool("stay_search", pc.steps[0].args, session.userId, uid("run"));
  if (r.error) return reply(session, sid, friendlyError(r));
  const top = r.results[0];
  const nights = pc.steps[0].args.nights;
  const book = { name: "stay_book", args: { property_id: top.id, nights, property_name: top.name }, missing: [] };
  session.history.push({ role: "assistant", content: `Found options — top pick: **${top.name}** (${fmtNgn(top.price_per_night)}/night).` });
  return askConfirm(session, sid, book);
}
