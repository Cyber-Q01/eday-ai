// EDAY vertical coverage tests — every vertical's simulated middleware action
// must complete end-to-end (chop, shop, work, wallet top-up).
import { test } from "node:test";
import assert from "node:assert/strict";
import { actions, getStateForTesting } from "../src/backend.js";

function walletOf(uid) {
  return getStateForTesting().wallets.get(uid).balance;
}

test("chop_order: food order debits wallet and creates order", () => {
  const uid = "ut_chop";
  const r = actions.chop_order(uid, { city: "Ibadan", description: "order jollof rice and chicken" });
  assert.equal(r.success, true);
  assert.equal(r.order.vertical, "chop");
  assert.equal(r.order.item, "Jollof rice & chicken");
  assert.equal(r.order.amount, 4500);
  assert.equal(walletOf(uid), 50000 - 4500);
  assert.ok(r.order.id.startsWith("ORD_"));
});

test("shop_order: catalog item order completes", () => {
  const uid = "ut_shop";
  const r = actions.shop_order(uid, { description: "buy a smartwatch" });
  assert.equal(r.success, true);
  assert.equal(r.order.vertical, "shop");
  assert.equal(r.order.item, "Smartwatch Pro");
  assert.equal(r.order.amount, 45000);
  assert.equal(walletOf(uid), 50000 - 45000);
});

test("shop_order: unknown item returns NO_MATCH (no charge)", () => {
  const uid = "ut_shop2";
  const r = actions.shop_order(uid, { description: "buy a rocket" });
  assert.equal(r.success, undefined);
  assert.equal(r.error, "NO_MATCH");
  assert.equal(getStateForTesting().wallets.has(uid), false); // wallet never touched
});

test("work_request: matches a pro, debits wallet", () => {
  const uid = "ut_work";
  const r = actions.work_request(uid, { description: "i need a plumber", city: "Ibadan" });
  assert.equal(r.success, true);
  assert.equal(r.order.vertical, "work");
  assert.equal(r.order.trade, "Plumber");
  assert.equal(r.order.amount, 15000);
  assert.equal(walletOf(uid), 50000 - 15000);
});

test("wallet_topup_start: returns payment instructions + ref, no charge", () => {
  const uid = "ut_tp";
  const r = actions.wallet_topup_start(uid, { amount_ngn: 10000 });
  assert.equal(r.success, true);
  assert.ok(r.ref.startsWith("TP_"));
  assert.match(r.message, /GTBank/);
  assert.equal(getStateForTesting().wallets.has(uid), false); // money comes IN later (simulated), no debit
});

test("ride_quote gives inDrive-style options across vehicle types", () => {
  const r = actions.ride_quote("ut_ride", { pickup: "Ikeja", destination: "Victoria Island" });
  assert.equal(r.success, true);
  const types = r.rides.map((x) => x.type);
  assert.ok(types.includes("Bike") && types.includes("Car") && types.includes("Premium"));
  assert.ok(r.rides.every((x) => x.fare > 0));
});
