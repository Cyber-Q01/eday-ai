// ---- EDAY AI Orchestration Layer ----
// Central config: everything reads env once here.
// A local `.env` file (repo root, git-ignored) is auto-loaded if present —
// real environment variables always win. No dotenv dependency.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

try {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const k = m[1];
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
} catch { /* .env is optional — never crash on it */ }

const env = (k, d = "") => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
};

export const config = {
  port: parseInt(env("PORT", "3000"), 10),
  corsOrigins: env("CORS_ORIGINS", "*").split(",").map((s) => s.trim()),
  apiKey: env("API_KEY", ""),
  // LLM provider: auto | mock | openai | gemini   (auto picks openai → gemini → mock by available keys)
  llmProvider: env("LLM_PROVIDER", env("LLM_MODE", "auto")), // LLM_MODE kept for back-compat
  openaiApiKey: env("OPENAI_API_KEY", ""),
  geminiApiKey: env("GEMINI_API_KEY", ""),
  llmBaseUrl: env("LLM_BASE_URL", ""),                    // custom OpenAI-compatible (LiteLLM/Groq…) — overrides provider default
  llmModel: env("LLM_MODEL", ""),                          // per-provider default below when empty
  skipConfirm: env("SKIP_CONFIRM", "false") === "true",
  mockWalletBalance: parseInt(env("MOCK_WALLET_BALANCE", "50000"), 10),
  maxPlanSteps: parseInt(env("MAX_PLAN_STEPS", "6"), 10),
  memoryFile: env("MEMORY_FILE", ""),
  auditFile: env("AUDIT_FILE", ""),
  toolMode: env("TOOL_MODE", "mock"), // mock | http
  // embeddings
  embeddingProvider: env("EMBEDDING_PROVIDER", "auto"), // auto | gemini | mock
  embeddingModel: env("EMBEDDING_MODEL", "gemini-embedding-001"),
  embeddingDim: parseInt(env("EMBEDDING_DIM", "768"), 10),
  // fallback models tried in order when the primary LLM model returns 429/5xx
  // (Gemini free tier overloads are common — e.g. "gemini-2.5-flash-lite,gemini-flash-latest")
  llmFallbackModels: env("LLM_FALLBACK_MODELS", "gemini-2.5-flash-lite,gemini-flash-latest")
    .split(",").map((s) => s.trim()).filter(Boolean),
  backendInternalUrl: env("BACKEND_INTERNAL_URL", ""),
  backendInternalKey: env("BACKEND_INTERNAL_KEY", ""),
  // Supabase (user's BaaS project) for persistent memory + audit
  supabaseUrl: env("SUPABASE_URL", ""),
  supabaseServiceKey: env("SUPABASE_SERVICE_ROLE_KEY", ""), // server-only, never client
  storeBackend: env("STORE_BACKEND", "auto"),               // auto | memory | file | supabase
  // WhatsApp Cloud API (Meta) — see README "Connect WhatsApp"
  whatsappVerifyToken: env("WHATSAPP_VERIFY_TOKEN", ""),    // any secret string YOU choose (webhook handshake)
  whatsappToken: env("WHATSAPP_TOKEN", ""),                 // system-user (or temp) access token with whatsapp_business_messaging
  whatsappPhoneId: env("WHATSAPP_PHONE_ID", ""),            // phone-number-id from Meta dashboard (API Setup)
  whatsappAppSecret: env("WHATSAPP_APP_SECRET", ""),        // optional — enables X-Hub-Signature-256 verification
  whatsappGraphVersion: env("WHATSAPP_GRAPH_VERSION", "v22.0"),
  whatsappDryRun: env("WHATSAPP_DRY_RUN", "false") === "true", // log instead of calling Graph (webhook testing w/o token)
};

// litellm = self-hosted LiteLLM proxy (free, MIT). Use OPENAI_API_KEY = proxy master
// key + LLM_BASE_URL = http://<litellm-host>:4000/v1. Model = alias defined in the proxy.
const PROVIDER_DEFAULTS = {
  openai: { base: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  gemini: { base: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-2.5-flash" },
  litellm: { base: "", model: "gemini-flash" },
};

export function effectiveLlmMode() {
  let p = config.llmProvider;
  if (p === "auto") p = config.openaiApiKey ? "openai" : config.geminiApiKey ? "gemini" : "mock";
  if (p === "openai" && !config.openaiApiKey) p = config.geminiApiKey ? "gemini" : "mock";
  if (p === "gemini" && !config.geminiApiKey) p = config.openaiApiKey ? "openai" : "mock";
  if (p === "litellm" && !(config.openaiApiKey && config.llmBaseUrl)) p = "mock";
  return p;
}

export function isMock() {
  return effectiveLlmMode() === "mock";
}

export function llmEndpoint() {
  const p = effectiveLlmMode();
  if (p === "mock") return null;
  const def = PROVIDER_DEFAULTS[p] || PROVIDER_DEFAULTS.openai;
  const base = (config.llmBaseUrl || def.base).replace(/\/$/, "");
  const key = p === "gemini" ? config.geminiApiKey : config.openaiApiKey;
  return {
    provider: p,
    base,
    model: config.llmModel || def.model,
    key,
    // Gemini-only: sibling models to fall back to when the primary is overloaded
    fallbackModels: p === "gemini" ? config.llmFallbackModels : [],
  };
}

export function resolveStoreBackend() {
  if (config.storeBackend !== "auto") return config.storeBackend;
  if (config.supabaseUrl && config.supabaseServiceKey) return "supabase";
  if (config.memoryFile) return "file";
  return "memory";
}

export function effectiveEmbedMode() {
  let p = config.embeddingProvider;
  if (p === "auto") p = config.geminiApiKey ? "gemini" : "mock";
  if (p === "gemini" && !config.geminiApiKey) p = "mock";
  return p;
}

export function embeddingDim() {
  return config.embeddingDim || 768;
}
