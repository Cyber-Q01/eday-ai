// Rule-parser regressions — word-boundary matching + no false verticals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockClassifyIntent } from "../src/mockIntent.js";

test("mock: plumber is WORK, not data ('mb' substring bug)", () => {
  const r = mockClassifyIntent("i need a plumber in ibadan");
  assert.equal(r.vertical, "work");
  assert.equal(r.subtype, "work_request");
});

test("mock: 'hire a plumber' is not a greeting ('hi' substring bug)", () => {
  const r = mockClassifyIntent("hire a plumber");
  assert.notEqual(r.intent, "greeting");
  assert.equal(r.vertical, "work");
});

test("mock: 'which hotel in lagos' is STAY, not a greeting", () => {
  const r = mockClassifyIntent("which hotel in lagos");
  assert.equal(r.vertical, "stay");
});

test("mock: meta question about sending maps to send (destination found, pickup asked later)", () => {
  const r = mockClassifyIntent("What do i need to give you if i want to send a package to ikeja");
  assert.equal(r.vertical, "send");
  assert.equal(r.subtype, "send_package");
  assert.equal(r.entities.destination, "ikeja");
});

test("mock: member/gb words don't trigger data", () => {
  assert.equal(mockClassifyIntent("i am a member").vertical, "none");
  assert.equal(mockClassifyIntent("buy data").subtype, "data"); // still works with the actual word
});

test("mock: bare help still help", () => {
  assert.equal(mockClassifyIntent("help").intent, "help");
});

test("mock: ride phrases classify ride", () => {
  const r = mockClassifyIntent("book a ride from ikeja to lekki");
  assert.equal(r.vertical, "ride");
  assert.equal(r.entities.pickup, "ikeja");
  assert.equal(r.entities.destination, "lekki");
});
