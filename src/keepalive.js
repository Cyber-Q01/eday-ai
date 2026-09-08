// ---- Keep-awake heartbeat ----------------------------------------------------
// Railway's app-sleeping ("Serverless") puts a service to sleep after ~10
// minutes of NO OUTBOUND traffic — inbound requests (webhooks, external
// uptime monitors) do NOT keep it awake, they only wake it after it has
// slept. The reliable way to stay warm is outbound activity started from
// INSIDE the service: this module pings the app's own public URL (an
// outbound connection from the container) every few minutes, so the sleep
// clock never reaches 10 minutes.
//
// Target resolution order:
//   1. KEEPALIVE_URL           — explicit override (any URL you like,
//                                e.g. https://<host>/ or an external probe)
//                                set to "off" to disable the heartbeat
//   2. RAILWAY_PUBLIC_DOMAIN   — Railway public networking (newer)
//   3. RAILWAY_STATIC_URL      — Railway (older alias)
//   otherwise: disabled with a log line (e.g. local dev, Render w/o domain)
//
// Interval: KEEPALIVE_INTERVAL_MIN (minutes, default 4, min 1, max 60).
import { log } from "./util.js";

/** Pure: decide the heartbeat target from env-ish values. Returns a URL string
 *  or null when no public URL is known / explicitly disabled. */
export function resolveKeepaliveTarget(env = {}) {
  const url = String(env.KEEPALIVE_URL || "").trim();
  if (url) {
    if (/^(off|false|0|none|disable)$/i.test(url)) return null;
    if (!/^https?:\/\//i.test(url)) return null; // malformed → disabled
    return url;
  }
  const dom = String(env.RAILWAY_PUBLIC_DOMAIN || env.RAILWAY_STATIC_URL || "").trim();
  if (!dom) return null;
  return `https://${dom}/`;
}

/** Start the heartbeat. Returns the interval handle (caller may clearInterval). */
export function startKeepalive({ target, intervalMin = 4, fetchImpl = fetch, onLog = log } = {}) {
  if (!target) {
    onLog("[keepalive] no public URL known — heartbeat disabled. Set KEEPALIVE_URL (or Railway public domain) to keep the app awake.");
    return null;
  }
  const min = Math.min(60, Math.max(1, Math.round(Number(intervalMin) || 4)));
  onLog(`[keepalive] heartbeat ON — outbound ping to ${target} every ${min} min (keeps Railway/cloud sleepers from sleeping the app)`);

  const tick = async () => {
    const t0 = Date.now();
    try {
      const res = await fetchImpl(target, { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) onLog(`[keepalive] ping -> HTTP ${res.status} (${res.statusText || ""}) in ${Date.now() - t0}ms`);
      // 2xx or 4xx/5xx: the app is reachable either way; only log problems.
    } catch (e) {
      onLog(`[keepalive] ping failed: ${String(e.message || e).slice(0, 140)}`);
    }
  };

  // first ping immediately (right after boot), then on the interval
  tick();
  return setInterval(tick, min * 60_000);
}
