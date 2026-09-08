// ---- SIMULATED EDAY backend (TOOL_MODE=mock). Mirrors the future real backend's
//      action surface so the AI layer is testable end-to-end TODAY:
//      wallet, orders/bookings, provider sims (airtime, electricity, send, ride, stay).
//      When the real Supabase backend is live, TOOL_MODE=http routes to it via tools.js. ----

import { config } from "./config.js";
import { uid, nowIso } from "./util.js";

const state = {
  wallets: new Map(),            // userId -> { balance, history: [] }
  orders: new Map(),             // orderId -> order
  bookings: new Map(),           // bookingId -> booking
};

const DB = {
  meters: new Map([
    ["41234567890", { disco: "ibedc", name: "ADEBAYO FEMI", type: "prepaid" }],
    ["51234567890", { disco: "ekedc", name: "OKONKWO CHIOMA", type: "prepaid" }],
    ["61234567890", { disco: "ikede", name: "MUSA IBRAHIM", type: "prepaid" }],
  ]),
  airtime: { mtn: { label: "MTN", fee: 0 }, glo: { label: "Glo", fee: 0 }, airtel: { label: "Airtel", fee: 0 }, "9mobile": { label: "9mobile", fee: 0 } },
  stay: [
    { id: "st_abuja01", name: "Transcorp Hilton Abuja", city: "Abuja", price_per_night: 185000, rating: 4.7 },
    { id: "st_abuja02", name: "Fraser Suites Abuja", city: "Abuja", price_per_night: 95000, rating: 4.4 },
    { id: "st_lagos01", name: "Eko Hotel & Suites", city: "Lagos", price_per_night: 165000, rating: 4.6 },
    { id: "st_ibadan01", name: "Premier Hotel Ibadan", city: "Ibadan", price_per_night: 42000, rating: 4.1 },
  ],
};

function getWallet(userId) {
  if (!state.wallets.has(userId)) {
    state.wallets.set(userId, { balance: config.mockWalletBalance, history: [] });
  }
  return state.wallets.get(userId);
}

function ledger(userId, amount, kind, ref, meta = {}) {
  const w = getWallet(userId);
  w.balance += amount;
  w.history.unshift({ amount, kind, ref, meta, at: nowIso() });
}

const guard = {
  airtime(userId, { network, phone, amount_ngn }) {
    if (!DB.airtime[network]) return { error: "UNKNOWN_NETWORK", message: `Unknown network "${network}". Supported: mtn, glo, airtel, 9mobile.` };
    if (!/^0[789][01]\d{8}$/.test(phone || "")) return { error: "INVALID_PHONE", message: "Enter a valid 11-digit Nigerian phone, e.g. 08031234567." };
    const amt = Number(amount_ngn);
    if (!(amt >= 50 && amt <= 50000)) return { error: "INVALID_AMOUNT", message: "Airtime must be ₦50 – ₦50,000." };
    return null;
  },
  electricity(userId, { disco, meter_number, amount_ngn }) {
    const amt = Number(amount_ngn);
    if (!(amt >= 100 && amt <= 1000000)) return { error: "INVALID_AMOUNT", message: "Electricity purchase must be ₦100 – ₦1,000,000." };
    const meter = DB.meters.get(String(meter_number));
    if (!meter) return { error: "METER_NOT_FOUND", message: `Meter ${meter_number} not found in ${disco?.toUpperCase() || "DisCo"} records. Test meters: 41234567890 (IBEDC), 51234567890 (EKEDC), 61234567890 (IKEDC).` };
    if (disco && String(meter.disco) !== String(disco).toLowerCase().replace(/[^a-z]/g, "")) {
      return { error: "DISCO_MISMATCH", message: `Meter ${meter_number} is registered under ${meter.disco.toUpperCase()}, not ${disco.toUpperCase()}.` };
    }
    return null;
  },
  send(userId, { pickup, destination }) {
    if (!pickup || !destination) return { error: "MISSING_ADDRESS", message: "I need both a pickup address and a destination." };
    return null;
  },
};

// ---------- actions ----------
export const actions = {
  wallet_balance(userId) {
    const w = getWallet(userId);
    return { balance: w.balance, currency: "NGN", history: w.history.slice(0, 10) };
  },

  airtime_purchase(userId, args) {
    const g = guard.airtime(userId, args);
    if (g) return g;
    const w = getWallet(userId);
    const amt = Number(args.amount_ngn);
    if (w.balance < amt) return { error: "INSUFFICIENT_FUNDS", message: `Your wallet balance is ₦${w.balance.toLocaleString()} — top up first.` };
    ledger(userId, -amt, "debit", `airtime_${uid()}`, { service: "bills", product: "airtime", network: args.network, phone: args.phone });
    return {
      success: true, ref: `VT_${uid().slice(0, 10)}`, service: "airtime",
      network: DB.airtime[args.network].label, phone: args.phone, amount: amt,
      status: "COMPLETED", message: `${DB.airtime[args.network].label} airtime of ₦${amt.toLocaleString()} sent to ${args.phone}.`,
    };
  },

  data_purchase(userId, args) {
    const g = guard.airtime(userId, args);
    if (g) return g;
    const w = getWallet(userId);
    const amt = Number(args.amount_ngn);
    if (w.balance < amt) return { error: "INSUFFICIENT_FUNDS", message: `Your wallet balance is ₦${w.balance.toLocaleString()} — top up first.` };
    ledger(userId, -amt, "debit", `data_${uid()}`, { service: "bills", product: "data", network: args.network, phone: args.phone });
    const gb = (amt / 1000).toFixed(1);
    return { success: true, ref: `DT_${uid().slice(0, 10)}`, service: "data", network: DB.airtime[args.network].label,
      phone: args.phone, amount: amt, status: "COMPLETED", message: `${gb}GB ${DB.airtime[args.network].label} data activated on ${args.phone}.` };
  },

  electricity_purchase(userId, args) {
    const g = guard.electricity(userId, args);
    if (g) return g;
    const w = getWallet(userId);
    const amt = Number(args.amount_ngn);
    if (w.balance < amt) return { error: "INSUFFICIENT_FUNDS", message: `Your wallet balance is ₦${w.balance.toLocaleString()} — top up first.` };
    ledger(userId, -amt, "debit", `elec_${uid()}`, { service: "bills", product: "electricity", disco: args.disco, meter: args.meter_number });
    const units = Math.round(amt / 46.5);
    const token = String(Math.floor(1000000000000 + Math.random() * 8999999999999));
    const meter = DB.meters.get(String(args.meter_number));
    const disco = (args.disco || meter.disco).toUpperCase();
    return {
      success: true, ref: `EC_${uid().slice(0, 10)}`, service: "electricity", disco, disco_code: args.disco || meter.disco,
      meter_number: args.meter_number, customer_name: meter.name, amount: amt,
      units_kwh: units, token, status: "COMPLETED",
      message: `${units} kWh purchased for ${meter.name} (${disco}). Token: ${token}`,
    };
  },

  send_quote(userId, args) {
    const g = guard.send(userId, args);
    if (g) return g;
    // deterministic pseudo-quote from 3 sim providers
    const seed = (args.pickup + args.destination + (args.package_type || "")).length;
    const quotes = [
      { provider: "gigl", amount: 3500 + seed * 137, eta_minutes: 40 + (seed % 60), tier: "Same-day" },
      { provider: "dhl", amount: 5200 + seed * 173, eta_minutes: 60 + (seed % 120), tier: "Express" },
      { provider: "edispatch", amount: 2900 + seed * 109, eta_minutes: 50 + (seed % 90), tier: "Economy" },
    ].sort((a, b) => a.amount - b.amount);
    const chosen = quotes[0];
    return { success: true, quotes, chosen: { ...chosen, provider: chosen.provider, reason: "Lowest price" }, currency: "NGN" };
  },

  send_book(userId, args) {
    const amount = Number(args.amount || args.quote?.amount || 0);
    const provider = args.provider || args.quote?.provider;
    if (!amount || !provider) return { error: "MISSING_QUOTE", message: "Book a quote first via send_quote." };
    const w = getWallet(userId);
    if (w.balance < amount) return { error: "INSUFFICIENT_FUNDS", message: `Your wallet balance is ₦${w.balance.toLocaleString()}.` };
    ledger(userId, -amount, "debit", `send_${uid()}`, { service: "send", provider });
    const bookingId = `BK_${uid().slice(0, 10)}`;
    const order = {
      id: `ORD_${uid().slice(0, 10)}`, userId, vertical: "send", status: "booked",
      provider, amount, pickup: args.pickup, destination: args.destination,
      eta_minutes: args.eta_minutes || args.quote?.eta_minutes, bookingId,
      events: [{ at: nowIso(), status: "booked", note: `Booked with ${provider}` }], createdAt: nowIso(),
    };
    state.orders.set(order.id, order);
    scheduleProgress(order.id, "picked_up", "Courier picked up the package", "in_transit", "Package in transit", "delivered", "Package delivered ✓");
    return { success: true, order, message: `Booked ${provider} for ₦${amount.toLocaleString()} (ETA ${args.eta_minutes || "—"} min). Your order ID: ${order.id}` };
  },

  send_track(userId, { order_ref }) {
    const order = [...state.orders.values()].find((o) => o.userId === userId && o.id === order_ref);
    if (!order) return { error: "NOT_FOUND", message: `No order found with ref ${order_ref}.` };
    const last = order.events[order.events.length - 1];
    return { order_id: order.id, status: order.status, last_event: last, events: order.events };
  },

  order_status(userId, { order_ref }) {
    const order = [...state.orders.values()].find((o) => o.userId === userId && o.id === order_ref);
    if (!order) return { error: "NOT_FOUND", message: `No order found with ref ${order_ref}.` };
    const last = order.events[order.events.length - 1];
    return { order_id: order.id, vertical: order.vertical, status: order.status, provider: order.provider, amount: order.amount, last_event: last };
  },

  ride_quote(userId, { pickup, destination }) {
    if (!pickup || !destination) return { error: "MISSING_ADDRESS", message: "I need pickup and destination." };
    const dist = 5 + ((pickup + destination).length % 25);
    return {
      success: true, distance_km: dist, duration_min: Math.round(dist * 2.1),
      rides: [
        { type: "Bike", fare: 1200 + dist * 120 },
        { type: "Car", fare: 1800 + dist * 220 },
        { type: "Premium", fare: 4000 + dist * 380 },
      ],
      currency: "NGN",
    };
  },

  ride_book(userId, { pickup, destination, ride_type = "Car" }) {
    const w = getWallet(userId);
    const quote = actions.ride_quote(userId, { pickup, destination });
    const ride = quote.rides.find((r) => r.type.toLowerCase() === String(ride_type).toLowerCase()) || quote.rides[1];
    if (w.balance < ride.fare) return { error: "INSUFFICIENT_FUNDS", message: `Your wallet balance is ₦${w.balance.toLocaleString()}.` };
    ledger(userId, -ride.fare, "debit", `ride_${uid()}`, { service: "ride", ride_type: ride.type });
    const order = {
      id: `ORD_${uid().slice(0, 10)}`, userId, vertical: "ride", status: "driver_assigned",
      ride_type: ride.type, amount: ride.fare, pickup, destination, distance_km: quote.distance_km,
      driver: { name: "Hugo S.", rating: 4.8, vehicle: "Toyota Camry · ABC-123-DE" },
      events: [{ at: nowIso(), status: "driver_assigned", note: "Driver assigned" }], createdAt: nowIso(),
    };
    state.orders.set(order.id, order);
    scheduleProgress(order.id, "driver_arriving", "Driver is arriving (5 min)", "in_progress", "Trip started", "completed", "Trip completed ✓", 8000);
    return { success: true, order, message: `${ride.type} booked (₦${ride.fare.toLocaleString()}). Driver: ${order.driver.name} ${order.driver.vehicle}. Order ID: ${order.id}` };
  },

  stay_search(userId, { city = "Abuja", nights = 1 }) {
    const list = DB.stay.filter((s) => s.city.toLowerCase().includes(city.toLowerCase()));
    if (!list.length) return { error: "NO_RESULTS", message: `No properties found in ${city}. Try Abuja, Lagos or Ibadan.` };
    return { success: true, results: list.map((s) => ({ ...s, total_ngn: s.price_per_night * nights, nights })) };
  },

  stay_book(userId, { property_id, nights = 1 }) {
    const prop = DB.stay.find((s) => s.id === property_id);
    if (!prop) return { error: "NOT_FOUND", message: "Property not found. Search first." };
    const total = prop.price_per_night * nights;
    const w = getWallet(userId);
    if (w.balance < total) return { error: "INSUFFICIENT_FUNDS", message: `Your wallet balance is ₦${w.balance.toLocaleString()}.` };
    ledger(userId, -total, "debit", `stay_${uid()}`, { service: "stay", property: prop.name });
    const order = {
      id: `ORD_${uid().slice(0, 10)}`, userId, vertical: "stay", status: "confirmed",
      property: prop.name, city: prop.city, nights, amount: total,
      events: [{ at: nowIso(), status: "confirmed", note: `Confirmed: ${prop.name}, ${nights} night(s)` }], createdAt: nowIso(),
    };
    state.orders.set(order.id, order);
    return { success: true, order, message: `${prop.name} confirmed for ${nights} night(s) — ₦${total.toLocaleString()} paid from wallet. Order ID: ${order.id}` };
  },

  // ---------- CHOP (food delivery) ----------
  chop_order(userId, args = {}) {
    const { city = "Lagos", description = "" } = args;
    const text = String(description || "").toLowerCase();
    const menu = [
      { kw: ["jollof", "rice", "chicken"], label: "Jollof rice & chicken", price: 4500 },
      { kw: ["amala", "ewedu", "gbegiri"], label: "Amala & ewedu", price: 3500 },
      { kw: ["suya", "grill"], label: "Suya platter", price: 6000 },
      { kw: ["shawarma"], label: "Chicken shawarma", price: 4000 },
      { kw: ["small chops", "snacks"], label: "Small chops box", price: 3500 },
    ];
    const pick = menu.find((m) => m.kw.some((k) => text.includes(k)));
    const item = pick || { label: "Chef's special", price: 5000 };
    const vendor = { ibadan: "Amala Skillet (Bodija)", lagos: "Jollof Republic (Yaba)", abuja: "Suya & Co (Wuse)" }[String(city).toLowerCase()] || "EDAY Kitchen";
    const total = item.price;
    const w = getWallet(userId);
    if (w.balance < total) return { error: "INSUFFICIENT_FUNDS", message: `Your wallet balance is ₦${w.balance.toLocaleString()}.` };
    ledger(userId, -total, "debit", `chop_${uid()}`, { service: "chop", item: item.label, vendor });
    const order = {
      id: `ORD_${uid().slice(0, 10)}`, userId, vertical: "chop", status: "confirmed",
      vendor, item: item.label, city: city || "Lagos", amount: total, eta_minutes: 40,
      events: [{ at: nowIso(), status: "confirmed", note: `Order confirmed: ${item.label} from ${vendor}` }], createdAt: nowIso(),
    };
    state.orders.set(order.id, order);
    scheduleProgress(order.id, "preparing", "Kitchen is preparing your order", "out_for_delivery", "Rider picked up your order", "delivered", "Order delivered ✓");
    return { success: true, order, message: `🍛 ${item.label} (₦${total.toLocaleString()}) ordered from ${vendor}, ${city || "Lagos"}. ETA 40 min. Order ID: ${order.id}` };
  },

  // ---------- SHOP (commerce) ----------
  shop_order(userId, args = {}) {
    const { description = "" } = args;
    const text = String(description || "").toLowerCase();
    const catalog = [
      { kw: ["watch"], label: "Smartwatch Pro", price: 45000 },
      { kw: ["sneaker", "shoe", "trainer"], label: "Running sneakers", price: 38000 },
      { kw: ["phone"], label: "Smartphone X2", price: 185000 },
      { kw: ["headphone", "earbud", "airpod"], label: "Wireless earbuds", price: 22000 },
      { kw: ["power bank", "charger"], label: "20k mAh power bank", price: 15000 },
      { kw: ["bag", "backpack"], label: "EDAY travel backpack", price: 28000 },
    ];
    const pick = catalog.find((c) => c.kw.some((k) => text.includes(k)));
    if (!pick) return { error: "NO_MATCH", message: "I couldn't find that in the EDAY mall. Try: smartwatch, sneakers, phone, earbuds, power bank, backpack." };
    const w = getWallet(userId);
    if (w.balance < pick.price) return { error: "INSUFFICIENT_FUNDS", message: `Your wallet balance is ₦${w.balance.toLocaleString()}.` };
    ledger(userId, -pick.price, "debit", `shop_${uid()}`, { service: "shop", item: pick.label });
    const order = {
      id: `ORD_${uid().slice(0, 10)}`, userId, vertical: "shop", status: "confirmed",
      item: pick.label, amount: pick.price, eta_days: 2,
      events: [{ at: nowIso(), status: "confirmed", note: `Order confirmed: ${pick.label}` }], createdAt: nowIso(),
    };
    state.orders.set(order.id, order);
    scheduleProgress(order.id, "packed", "Item packed at EDAY hub", "in_transit", "Shipment in transit", "delivered", "Delivered ✓");
    return { success: true, order, message: `🛍️ ${pick.label} (₦${pick.price.toLocaleString()}) ordered from EDAY Mall. Delivery 2 days. Order ID: ${order.id}` };
  },

  // ---------- WORK (gig/services) ----------
  work_request(userId, args = {}) {
    const { description = "", city = "Lagos" } = args;
    const text = String(description || "").toLowerCase();
    const pros = [
      { kw: ["plumb"], trade: "Plumber", price: 15000, name: "Musa B." },
      { kw: ["electric"], trade: "Electrician", price: 12000, name: "Tunde A." },
      { kw: ["clean"], trade: "Cleaner", price: 10000, name: "Blessing O." },
      { kw: ["mechanic"], trade: "Mechanic", price: 20000, name: "Emeka N." },
      { kw: ["tutor", "lesson", "teacher"], trade: "Tutor", price: 8000, name: "Aisha K." },
      { kw: ["tailor", "sew"], trade: "Tailor", price: 9000, name: "Funke D." },
      { kw: ["hair", "barber"], trade: "Hair stylist", price: 7000, name: "Zainab M." },
    ];
    const pick = pros.find((p) => p.kw.some((k) => text.includes(k)));
    if (!pick) return { error: "NO_MATCH", message: "I couldn't match that to a service. Try: plumber, electrician, cleaner, mechanic, tutor, tailor, barber." };
    const w = getWallet(userId);
    if (w.balance < pick.price) return { error: "INSUFFICIENT_FUNDS", message: `Your wallet balance is ₦${w.balance.toLocaleString()}.` };
    ledger(userId, -pick.price, "debit", `work_${uid()}`, { service: "work", trade: pick.trade });
    const order = {
      id: `ORD_${uid().slice(0, 10)}`, userId, vertical: "work", status: "pro_matched",
      trade: pick.trade, pro: pick.name, city: city || "Lagos", amount: pick.price, eta_minutes: 60,
      events: [{ at: nowIso(), status: "pro_matched", note: `Matched with ${pick.name} (${pick.trade})` }], createdAt: nowIso(),
    };
    state.orders.set(order.id, order);
    scheduleProgress(order.id, "on_the_way", `${pick.name} is on the way`, "in_progress", "Work started", "completed", "Job completed ✓", 20000);
    return { success: true, order, message: `🛠️ ${pick.trade}: ${pick.name} matched in ${city || "Lagos"} — ₦${pick.price.toLocaleString()} (arrival ~60 min). Job ID: ${order.id}` };
  },

  // ---------- WALLET top-up ----------
  wallet_topup_start(userId, { amount_ngn }) {
    const amt = Number(amount_ngn);
    if (!(amt >= 100 && amt <= 2000000)) return { error: "INVALID_AMOUNT", message: "Top-up must be between ₦100 and ₦2,000,000." };
    const ref = `TP_${uid().slice(0, 10)}`;
    // Mock middleware: "external payment" lands after ~10s (gated by AUTO_PROGRESS like order events)
    if (process.env.AUTO_PROGRESS !== "0") {
      setTimeout(() => {
        const w = getWallet(userId);
        ledger(userId, amt, "credit", ref, { service: "wallet_topup" });
        console.log(`[wallet] ${userId} credited ₦${amt.toLocaleString()} (${ref}) — balance ₦${w.balance.toLocaleString()}`);
      }, 10_000);
    }
    return {
      success: true,
      ref,
      amount_ngn: amt,
      message: `Top-up of ₦${amt.toLocaleString()} started. Transfer to EDAY Wallet (GTBank ••0123456789) with reference ${ref} — your wallet updates automatically once payment confirms.`,
    };
  },

  support_ticket(userId, { description }) {
    const ticketId = `TK_${uid().slice(0, 8)}`;
    return { success: true, ticket_id: ticketId, message: `Support ticket ${ticketId} created. Our team will reply within 2 hours.` };
  },

  help_menu(userId) {
    return {
      success: true,
      message: "I can help you with: 📱 Airtime & data (e.g. “buy ₦500 MTN airtime for 08031234567”) · ⚡ Electricity (e.g. “pay ₦5000 prepaid for meter 41234567890”) · 📦 Send a package · 🚗 Book a ride · 🏨 Book a stay · 🛍️ Chop/Shop · 💼 Work services · Track orders (send an order ID) · Wallet balance.",
    };
  },
};

const AUTO_PROGRESS = process.env.AUTO_PROGRESS !== "0";
function scheduleProgress(orderId, st1, n1, st2, n2, st3, n3, base = 15000) {
  if (!AUTO_PROGRESS) return;
  setTimeout(() => pushEvent(orderId, st1, n1), base);
  setTimeout(() => pushEvent(orderId, st2, n2), base * 2);
  setTimeout(() => pushEvent(orderId, st3, n3), base * 3);
}
function pushEvent(orderId, status, note) {
  const order = state.orders.get(orderId);
  if (!order) return;
  order.status = status;
  order.events.push({ at: nowIso(), status, note });
}

export const actionNames = Object.keys(actions);
export function getStateForTesting() { return state; }
