// ---- Audit trail: every turn + tool call logged (console JSON + optional file/Supabase). ----
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { nowIso, sha } from "./util.js";

const logFile = config.auditFile || "";
const sbOn = Boolean(config.supabaseUrl && config.supabaseServiceKey);

class Audit {
  constructor() {
    this.buffer = [];
    if (sbOn) this.sbUrl = `${config.supabaseUrl.replace(/\/$/, "")}/rest/v1`;
    if (sbOn) console.log(`[audit] backend=supabase (table ai_audit)`);
  }
  write(entry) {
    const row = { at: nowIso(), id: sha(nowIso() + Math.random()), ...entry };
    this.buffer.push(row);
    if (this.buffer.length > 2000) this.buffer.shift();
    console.log("AUDIT " + JSON.stringify(row));
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        appendFileSync(logFile, JSON.stringify(row) + "\n");
      } catch { /* ignore */ }
    }
    if (sbOn) {
      // fire-and-forget — never block a reply on audit
      fetch(`${this.sbUrl}/ai_audit`, {
        method: "POST",
        headers: {
          apikey: config.supabaseServiceKey,
          Authorization: `Bearer ${config.supabaseServiceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ id: row.id, at: row.at, entry: row }),
      }).catch(() => {});
    }
    return row;
  }
  recent(n = 100) { return this.buffer.slice(-n).reverse(); }
}
export const audit = new Audit();
