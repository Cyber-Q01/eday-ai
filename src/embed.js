// ---- Embeddings: semantic vector creation for memory.
//      Providers:
//        gemini — Google gemini-embedding-001 via native REST (batchEmbedContents),
//                 768-dim pinned via outputDimensionality (matches schema vector(768))
//        mock   — deterministic local hashing embedder (768-dim, no key needed,
//                 good enough to exercise pgvector similarity search end-to-end)
//      auto = gemini when GEMINI_API_KEY is set, else mock. ----

import { config, effectiveEmbedMode } from "./config.js";
import { log } from "./util.js";

const DIM = 768; // matches embeddingDim() — keep in sync with supabase/schema.sql

export function embedMode() {
  return effectiveEmbedMode();
}

async function geminiEmbed(text) {
  const model = config.embeddingModel || "gemini-embedding-001";
  const dim = config.embeddingDim || 768;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${encodeURIComponent(config.geminiApiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          model: `models/${model}`,
          content: { parts: [{ text }] },
          ...(dim ? { outputDimensionality: dim } : {}), // pin 768 to match ai_embeddings vector(768)
        },
      ],
    }),
    signal: AbortSignal.timeout(20_000), // never let a stalled embedder block the flow
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`gemini embed HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const values = data?.embeddings?.[0]?.values;
  if (!Array.isArray(values)) throw new Error("gemini embed: no values in response");
  return normalize(values);
}

// Deterministic mock embedder: word + char-trigram hashing into DIM buckets,
// sign-weighted, L2-normalised. Same text → same vector; related text → high cosine.
function mockEmbed(text) {
  const vec = new Float64Array(DIM);
  const tokens = String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  const raw = String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const grams = [];
  for (const tok of tokens) grams.push(tok);
  for (let i = 0; i + 2 < raw.length; i++) grams.push(raw.slice(i, i + 3));
  for (const g of grams) {
    const h = hash2(g);
    const idx = h % DIM;
    vec[idx] += (h & 1) === 0 ? 1 : -1;
  }
  if (tokens.length === 0) vec[0] = 1;
  return normalize(vec);
}

function hash2(s) {
  let a = 2166136261 >>> 0, b = 2246822519 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a ^= c; a = Math.imul(a, 16777619);
    b ^= c + i; b = Math.imul(b, 2246822507);
  }
  return (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
}

export function normalize(vals) {
  const arr = Array.isArray(vals) ? Float64Array.from(vals) : vals;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / norm;
  return out;
}

export function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

export function toVectorLiteral(vec) {
  return "[" + Array.from(vec).map((n) => n.toFixed(7)).join(",") + "]";
}

/** Returns { vector: Float64Array, provider } — falls back mock on error. */
export async function embedText(text) {
  if (embedMode() === "gemini") {
    try {
      const vector = await geminiEmbed(text);
      return { vector, provider: "gemini" };
    } catch (e) {
      log("gemini embed failed, using mock:", e.message);
    }
  }
  return { vector: mockEmbed(text), provider: "mock" };
}

export { mockEmbed };
