// ---- Memory store: per-user preferences + recent episodes + SEMANTIC (vector)
//      memory via pgvector in your Supabase "Eday" project (ai_embeddings).
//      Backends: memory (default) | file | supabase.
//      Embeddings: gemini (free tier) or deterministic mock — see src/embed.js.
//      Falls back to in-memory on any Supabase error (logs a warning once). ----

import { config, resolveStoreBackend } from "./config.js";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "./util.js";
import { embedText, toVectorLiteral } from "./embed.js";

const SB_HEADERS = () => ({
  apikey: config.supabaseServiceKey,
  Authorization: `Bearer ${config.supabaseServiceKey}`,
  "Content-Type": "application/json",
});
const sbUrl = () => `${config.supabaseUrl.replace(/\/$/, "")}/rest/v1`;

class MemoryStore {
  constructor() {
    this.data = new Map(); // userId -> { prefs: [], episodes: [] }
    this.backend = resolveStoreBackend();
    this.file = config.memoryFile;
    this.warned = false;
    if (this.file && existsSync(this.file)) {
      try { this.data = new Map(Object.entries(JSON.parse(readFileSync(this.file, "utf8")))); } catch { /* ignore */ }
    }
    console.log(`[memory] backend=${this.backend}${this.backend === "supabase" ? " (" + config.supabaseUrl + ")" : ""}`);
  }
  _list(userId) {
    if (!this.data.has(userId)) this.data.set(userId, { prefs: [], episodes: [] });
    return this.data.get(userId);
  }
  _persist() {
    if (this.file) {
      try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.data)), "utf8"); } catch { /* ignore */ }
    }
  }
  async _sbFetch(path, opts) {
    const res = await fetch(`${sbUrl()}/${path}`, { ...opts, headers: { ...SB_HEADERS(), ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    // PostgREST returns 204 (RPC void) or 201 with an EMPTY body (return=minimal) —
    // both mean "done, nothing to read". Never JSON.parse an empty response.
    const t = await res.text().catch(() => "");
    if (!t) return null;
    try { return JSON.parse(t); } catch { return null; }
  }
  _warn(e) {
    if (!this.warned) { console.warn("[memory] supabase unavailable, falling back to memory:", e.message); this.warned = true; }
  }
  _supabase() { return this.backend === "supabase"; }

  async addPreference(userId, key, value) {
    const entry = { key, value, at: nowIso() };
    if (this._supabase()) {
      try {
        await this._sbFetch(`ai_memory?on_conflict=user_id,key`, {
          method: "POST",
          body: JSON.stringify({ user_id: userId, key, value: { ...entry }, updated_at: nowIso() }),
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        });
        return { saved: true, key, value, backend: "supabase" };
      } catch (e) { this._warn(e); }
    }
    const list = this._list(userId);
    list.prefs = list.prefs.filter((p) => p.key !== key);
    list.prefs.push(entry);
    this._persist();
    return { saved: true, key, value, backend: this.backend };
  }

  /** Store an episode in plain table AND as an embedding (semantic recall). */
  async addEpisode(userId, summary) {
    if (this._supabase()) {
      try {
        await this._sbFetch("ai_episodes", {
          method: "POST",
          body: JSON.stringify({ user_id: userId, summary, at: nowIso() }),
          headers: { Prefer: "return=minimal" },
        });
        // vector memory (best effort — embed failure never breaks the flow)
        const { vector, provider } = await embedText(summary);
        await this._sbFetch("rpc/ai_embedding_add", {
          method: "POST",
          body: JSON.stringify({ p_user: userId, p_kind: "episodic", p_content: summary, p_embedding: toVectorLiteral(vector) }),
        });
        return { backend: "supabase", embed_provider: provider };
      } catch (e) { this._warn(e); }
    }
    const list = this._list(userId);
    list.episodes.unshift({ summary, at: nowIso() });
    list.episodes = list.episodes.slice(0, 30);
    this._persist();
    return { backend: this.backend };
  }

  async recall(userId) {
    if (this._supabase()) {
      try {
        const [rows, eps] = await Promise.all([
          this._sbFetch(`ai_memory?user_id=eq.${encodeURIComponent(userId)}&select=key,value`),
          this._sbFetch(`ai_episodes?user_id=eq.${encodeURIComponent(userId)}&order=at.desc&limit=6&select=summary,at`).catch(() => []),
        ]);
        const prefs = (rows || []).map((r) => ({ key: r.key, ...(r.value || {}) }));
        return { prefs, recent_episodes: (eps || []).map((e) => ({ summary: e.summary, at: e.at })) };
      } catch (e) { this._warn(e); }
    }
    const list = this._list(userId);
    return { prefs: list.prefs, recent_episodes: list.episodes.slice(0, 6) };
  }

  /** Semantic search over the user's vector memory (pgvector). */
  async searchMemory(userId, query) {
    if (this._supabase()) {
      try {
        const { vector } = await embedText(query);
        const rows = await this._sbFetch("rpc/ai_memory_search", {
          method: "POST",
          body: JSON.stringify({ p_user: userId, p_query_embedding: toVectorLiteral(vector), p_k: 5 }),
        });
        return { results: (rows || []).map((r) => ({ content: r.content, kind: r.kind, similarity: Number(r.similarity).toFixed(3) })), backend: "supabase" };
      } catch (e) { this._warn(e); }
    }
    // local naive fallback: token-overlap scoring over stored episodes
    const q = String(query || "").toLowerCase();
    const toks = q.split(/[^a-z0-9]+/).filter(Boolean);
    const scored = this._list(userId).episodes
      .map((ep) => {
        const body = ep.summary.toLowerCase();
        const hits = toks.filter((t) => body.includes(t)).length;
        return { content: ep.summary, kind: "episodic", similarity: toks.length ? (hits / toks.length).toFixed(3) : "0.000", at: ep.at };
      })
      .filter((r) => Number(r.similarity) > 0)
      .sort((a, b) => Number(b.similarity) - Number(a.similarity))
      .slice(0, 5);
    return { results: scored, backend: this.backend };
  }

  async forget(userId) {
    if (this._supabase()) {
      try {
        await this._sbFetch(`ai_memory?user_id=eq.${encodeURIComponent(userId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
        await this._sbFetch(`ai_episodes?user_id=eq.${encodeURIComponent(userId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
        await this._sbFetch(`ai_embeddings?user_id=eq.${encodeURIComponent(userId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
        return { deleted: true, backend: "supabase" };
      } catch (e) { this._warn(e); }
    }
    this.data.delete(userId);
    this._persist();
    return { deleted: true, backend: this.backend };
  }
}

export const memory = new MemoryStore();
