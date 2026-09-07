import { randomUUID, createHash } from "node:crypto";

export const uid = (p = "") => (p ? `${p}_` : "") + randomUUID().replace(/-/g, "").slice(0, 18);
export const nowIso = () => new Date().toISOString();
export const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export const maskPhone = (p = "") => (p.length >= 8 ? p.slice(0, 4) + "****" + p.slice(-3) : "***");
export const maskMeter = (m = "") => (m.length >= 6 ? m.slice(0, 4) + "****" + m.slice(-3) : "***");

export const fmtNgn = (n) => "₦" + Number(n).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(body);
}

export const ok = (res, data) => sendJson(res, 200, { data });
export const err = (res, status, code, message, details) =>
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });

export const log = (...args) => console.log(new Date().toISOString(), ...args);
