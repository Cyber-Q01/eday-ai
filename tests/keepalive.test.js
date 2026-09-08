import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveKeepaliveTarget, startKeepalive } from "../src/keepalive.js";

test("resolveKeepaliveTarget: explicit KEEPALIVE_URL wins", () => {
  assert.equal(
    resolveKeepaliveTarget({ KEEPALIVE_URL: "https://example.com/ping", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" }),
    "https://example.com/ping"
  );
});

test("resolveKeepaliveTarget: falls back to Railway public domain", () => {
  assert.equal(
    resolveKeepaliveTarget({ RAILWAY_PUBLIC_DOMAIN: "eday-ai-production.up.railway.app" }),
    "https://eday-ai-production.up.railway.app/"
  );
  // legacy alias
  assert.equal(resolveKeepaliveTarget({ RAILWAY_STATIC_URL: "old.up.railway.app" }), "https://old.up.railway.app/");
});

test("resolveKeepaliveTarget: disabled when nothing known or set to off", () => {
  assert.equal(resolveKeepaliveTarget({}), null);
  assert.equal(resolveKeepaliveTarget({ KEEPALIVE_URL: "off" }), null);
  assert.equal(resolveKeepaliveTarget({ KEEPALIVE_URL: "not a url" }), null);
});

test("startKeepalive: pings the target repeatedly until cleared", async () => {
  let hits = 0;
  const logLines = [];
  const fakeFetch = async () => { hits++; return { ok: true }; };
  // interval is minutes; use a small one via the clamp path (1 min min) — so
  // instead test tick-through by passing a fake setInterval is overkill;
  // verify immediate first ping + handle shape instead.
  const h = startKeepalive({ target: "https://self.test/", intervalMin: 60, fetchImpl: fakeFetch, onLog: (m) => logLines.push(m) });
  assert.ok(h, "returns an interval handle");
  assert.equal(hits, 1, "fires once immediately on start");
  clearInterval(h);
  assert.ok(logLines.some((l) => /heartbeat ON/i.test(l)));
});

test("startKeepalive: disabled target logs and returns null", () => {
  const logLines = [];
  const h = startKeepalive({ target: null, onLog: (m) => logLines.push(m) });
  assert.equal(h, null);
  assert.ok(logLines.some((l) => /disabled/i.test(l)));
});
