// ---- HTTP server: health, chat API, memory controls, audit view, playground UI ----
import { createServer } from "node:http";
import { config } from "./config.js";
import { readBody, sendJson, ok, err, log, uid } from "./util.js";
import { handleMessage } from "./orchestrator.js";
import { memory } from "./memory.js";
import { audit } from "./audit.js";
import { playgroundHtml } from "./playground.js";
import { isMock, effectiveLlmMode, llmEndpoint, resolveStoreBackend } from "./config.js";
import { whatsappEnabled, verifyHandshake, signatureOk, handleWhatsappPayload, whatsappReady } from "./whatsapp.js";

function authorize(req) {
  if (!config.apiKey) return true;
  const h = req.headers.authorization || "";
  return h === `Bearer ${config.apiKey}` || h === config.apiKey;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") { sendJson(res, 204, {}); return; }

  // ---- WhatsApp Cloud API webhook (Meta calls this; NO API key needed) ----
  if (path === "/webhook/whatsapp") {
    if (req.method === "GET") {
      // Meta verification handshake
      if (!whatsappEnabled()) return err(res, 404, "NOT_CONFIGURED", "WHATSAPP_VERIFY_TOKEN not set on the server.");
      const challenge = verifyHandshake(url);
      if (challenge === null) return err(res, 403, "VERIFY_FAILED", "Verify token mismatch.");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(challenge);
      return;
    }
    if (req.method === "POST") {
      if (!whatsappEnabled()) return err(res, 404, "NOT_CONFIGURED", "WHATSAPP_VERIFY_TOKEN not set on the server.");
      // read raw body (needed for signature check), then parse
      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
      });
      if (!signatureOk(raw, req.headers["x-hub-signature-256"])) {
        log("[whatsapp] signature check failed — dropping webhook");
        return err(res, 403, "BAD_SIGNATURE", "Signature mismatch.");
      }
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* malformed */ }
      // process without blocking the response too long
      handleWhatsappPayload(body).catch((e) => log("[whatsapp] webhook error:", e.message));
      return ok(res, { received: true }); // ack fast (Meta retries on non-200)
    }
  }

  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(playgroundHtml());
    return;
  }

  if (!authorize(req)) return err(res, 401, "UNAUTHORIZED", "Missing or invalid API key.");

  if (req.method === "GET" && path === "/health") {
    return ok(res, {
      status: "ok",
      service: "eday-ai",
      version: "0.1.9",
      llm_provider: effectiveLlmMode(),
      model: isMock() ? "mock" : (config.llmModel || llmEndpoint()?.model || ""),
      store_backend: resolveStoreBackend(),
      tool_mode: config.toolMode,
      skip_confirm: config.skipConfirm,
      time: new Date().toISOString(),
    });
  }

  if (req.method === "POST" && path === "/v1/chat") {
    try {
      const body = await readBody(req);
      const { session_id, user_id, channel, message, context } = body;
      if (!message || typeof message !== "string" || !message.trim())
        return err(res, 400, "MISSING_MESSAGE", "Provide a non-empty message.");
      const out = await handleMessage({ session_id, user_id: user_id || "guest", channel, message, context });
      return ok(res, out);
    } catch (e) {
      log("chat error:", e);
      return err(res, 500, "INTERNAL", e.message || "Unexpected error");
    }
  }

  if (req.method === "GET" && path === "/v1/memory") {
    const userId = url.searchParams.get("user_id") || "guest";
    const mem = await memory.recall(userId);
    return ok(res, mem);
  }
  if (req.method === "DELETE" && path === "/v1/memory") {
    const userId = url.searchParams.get("user_id") || "guest";
    const r = await memory.forget(userId);
    return ok(res, r);
  }
  if (req.method === "GET" && path === "/v1/memory/search") {
    const userId = url.searchParams.get("user_id") || "guest";
    const q = url.searchParams.get("q") || "";
    if (!q) return err(res, 400, "MISSING_QUERY", "Provide ?q=search text");
    const mem = await memory.searchMemory(userId, q);
    return ok(res, mem);
  }
  if (req.method === "GET" && path === "/v1/audit") {
    const n = parseInt(url.searchParams.get("limit") || "50", 10);
    return ok(res, { entries: audit.recent(Math.min(n, 500)) });
  }
  if (req.method === "GET" && path === "/v1/tools") {
    return ok(res, { note: "Read-only catalog for reference. Execution happens via /v1/chat intents.", tools: [] });
  }
  if (req.method === "GET" && path === "/v1/meta") {
    return ok(res, {
      llm_provider: effectiveLlmMode(),
      model: isMock() ? "mock" : (config.llmModel || llmEndpoint()?.model || ""),
      store_backend: resolveStoreBackend(),
      supabase_connected: Boolean(config.supabaseUrl && config.supabaseServiceKey),
      whatsapp_connected: whatsappReady(),
      whatsapp_webhook: whatsappEnabled() ? "/webhook/whatsapp" : null,
      mock_wallet: config.mockWalletBalance,
      tool_mode: config.toolMode,
      models_note: "Set GEMINI_API_KEY (Gemini) or OPENAI_API_KEY (OpenAI / custom LLM_BASE_URL) for real LLM mode; otherwise mock mode runs.",
    });
  }

  return err(res, 404, "NOT_FOUND", `No route ${req.method} ${path}`);
});

server.listen(config.port, "0.0.0.0", () => {
  log(`EDAY AI orchestration listening on http://0.0.0.0:${config.port}`);
  log(`LLM mode: ${effectiveLlmMode()}${isMock() ? " (mock — set OPENAI_API_KEY for real intents)" : " — model " + config.llmModel}`);
  log(`WhatsApp: ${whatsappReady() ? "ready (token+phone id set)" : "NOT ready (need WHATSAPP_TOKEN + WHATSAPP_PHONE_ID)"} · webhook verify-token ${config.whatsappVerifyToken ? "set" : "MISSING"} · app-secret ${config.whatsappAppSecret ? `set (${config.whatsappAppSecret.length} chars)` : "MISSING (signature check skipped)"} · dry-run ${config.whatsappDryRun ? "ON" : "off"}`);
  log(`Open the playground: http://localhost:${config.port}/`);
});
