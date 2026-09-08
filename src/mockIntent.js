// ---- Rule-based intent fallback. Used when LLM_MODE=mock (no API key) so the
//      orchestration loop is fully testable. Good enough for demos & CI. ----

const NETWORKS = ["mtn", "glo", "airtel", "9mobile"];
const DISCOS = ["ibedc", "ikede", "ekedc", "aedc", "bedc", "eedc", "phedc", "kaduna"];

function has(t, ...words) {
  // WORD-BOUNDARY matching — raw substring matching is a trap:
  // "plumber" contains "mb" (data rule!), "hire" contains "hi" (greeting rule!).
  return words.some((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, "i").test(t);
  });
}

function extractAmount(t) {
  const m = t.match(/(?:₦|naira|ngn|n)\s*([0-9][0-9,]*)/i) || t.match(/([0-9][0-9,]*)\s*(?:naira|ngn)/i);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ""), 10);
}

function findPhone(t) {
  const m = t.match(/\b(0[789][01]\d{8})\b/);
  return m ? m[1] : null;
}

function findMeter(t) {
  const m = t.match(/\b(\d{11})\b/);
  return m ? m[1] : null;
}

function findNetwork(t) {
  const hit = NETWORKS.find((n) => t.includes(n));
  return hit || (has(t, "data") ? "mtn" : hit || null);
}

function findDisco(t) {
  return DISCOS.find((d) => t.includes(d)) || null;
}

export function mockClassifyIntent(text) {
  const t = " " + text.toLowerCase().replace(/[?.!,]/g, " ") + " ";
  const raw = text.trim();
  const fm = raw.match(/from\s+([a-z0-9 ,-]{3,45}?)(?=\s+(?:to|,|$))/i);
  const tm = (() => {
    const parts = raw.split(/\bto\s+/i);
    if (parts.length < 2) return null;
    const cand = parts[parts.length - 1].trim();
    if (!cand || cand.length > 45) return null;
    return cand;
  })();
  const nights = (raw.match(/(\d{1,2})\s*(?:night|day)s?/i) || [])[1];
  const cityM = raw.match(/(abuja|lagos|ibadan|port harcourt|ph|kaduna|kano|owerri|enugu|benin city)/i);
  const city = cityM ? (cityM[1].toLowerCase() === "ph" ? "port harcourt" : cityM[1].toLowerCase()) : "";
  const orderRef = (raw.match(/\b(ORD_?|BK_?|VT_?)[a-z0-9]+/i) || [])[0] || "";
  const entities = {
    network: findNetwork(t) || "",
    phone: findPhone(t) || "",
    disco: findDisco(t) || "",
    meter_number: findMeter(t) || "",
    meter_type: has(t, "postpaid") ? "postpaid" : "prepaid",
    amount_ngn: extractAmount(t) || (has(t, "pay", "buy", "recharge", "top up", "top-up", "purchase")
      ? parseInt((raw.match(/\b(\d{3,7})\b/) || [])[1] || "0", 10) : 0),
    pickup: fm ? fm[1].trim() : "",
    destination: tm || "",
    city, checkin: "", nights: nights ? parseInt(nights, 10) : 0, order_ref: orderRef, package_type: "", description: raw,
  };
  // ordering
  if (has(t, "hi", "hello", "hey", "good morning", "good afternoon", "good evening")) {
    return { intent: "greeting", vertical: "none", subtype: "none", entities, multi: [], confidence: 0.99 };
  }
  if (has(t, "help", "what can you do", "menu", "what do you")) {
    return { intent: "help", vertical: "none", subtype: "none", entities, multi: [], confidence: 0.99 };
  }
  if (has(t, "track", "where is my", "status of my", "status of order")) {
    return { intent: "track", vertical: "none", subtype: "none", entities, multi: [], confidence: 0.9 };
  }
  if (has(t, "balance", "how much do i have", "wallet")) {
    return { intent: "wallet", vertical: "none", subtype: "balance", entities, multi: [], confidence: 0.95 };
  }
  // bills
  if (has(t, "airtime", "recharge", "top up", "top-up", "buy credit")) {
    entities.network = entities.network || "mtn";
    return { intent: "service_request", vertical: "bills", subtype: "airtime", entities, multi: [], confidence: 0.93 };
  }
  if (has(t, "data bundle", "data", "internet", "bundle")) { // no "mb"/"gb" tokens — they match inside "plumber", "member"…
    entities.network = entities.network || "mtn";
    return { intent: "service_request", vertical: "bills", subtype: "data", entities, multi: [], confidence: 0.93 };
  }
  if (has(t, "electricity", "light", "nepa", "meter", "disco", "token", "power")) {
    return { intent: "service_request", vertical: "bills", subtype: "electricity", entities, multi: [], confidence: 0.9 };
  }
  // services
  if (has(t, "courier", "send", "deliver", "package", "parcel", "envelope")) {
    return { intent: "service_request", vertical: "send", subtype: "send_package", entities, multi: [], confidence: 0.92 };
  }
  if (has(t, "ride", "taxi", "cab", "car to", "transport", "pick me up", "take me to", "drop me", "go from", "going to", "trip to")) {
    return { intent: "service_request", vertical: "ride", subtype: "ride_now", entities, multi: [], confidence: 0.9 };
  }
  if (has(t, "hotel", "stay", "book a room", "accommodation", "lodging", "inn", "hostel")) {
    return { intent: "service_request", vertical: "stay", subtype: "stay_book", entities, multi: [], confidence: 0.9 };
  }
  if (has(t, "food", "chop", "meal", "burger", "order food", "restaurant", "hungry", "amala", "ewedu", "suya", "jollof", "shawarma", "pizza", "noodles")) {
    return { intent: "service_request", vertical: "chop", subtype: "chop_order", entities, multi: [], confidence: 0.85 };
  }
  if (has(t, "buy", "shop", "product", "groceries", "item", "smartwatch", "sneaker", "headphone", "earbud", "power bank", "backpack")) {
    return { intent: "service_request", vertical: "shop", subtype: "shop_order", entities, multi: [], confidence: 0.85 };
  }
  if (has(t, "plumber", "electrician", "mechanic", "cleaner", "tailor", "barber", "tutor", "repair", "fix my", "work request", "hire")) {
    return { intent: "service_request", vertical: "work", subtype: "work_request", entities, multi: [], confidence: 0.85 };
  }
  if (has(t, "travel", "abuja", "lagos trip", "visiting")) {
    return { intent: "service_request", vertical: "stay", subtype: "travel", entities, multi: [], confidence: 0.8 };
  }
  if (has(t, "refund", "complaint", "issue", "agent", "human", "support")) {
    return { intent: "support", vertical: "none", subtype: "none", entities, multi: [], confidence: 0.9 };
  }
  return { intent: "offscope", vertical: "none", subtype: "none", entities, multi: [], confidence: 0.6 };
}
