// ---- LLM client — OpenAI-compatible & Gemini (Google's OpenAI-compat endpoint).
//      Providers: openai | gemini | mock (no key). Custom OpenAI-compatible
//      endpoints (LiteLLM, Groq, Together…) via LLM_BASE_URL + OPENAI_API_KEY. ----

import { isMock, llmEndpoint } from "./config.js";
import { log } from "./util.js";

// Rotation cursor across keys — module-level so every call starts at the key
// that worked last time (spreads free-tier quota, skips known-bad keys).
let keyCursor = 0;

async function chatCompletion(messages, { temperature = 0, useJson = true } = {}) {
  const ep = llmEndpoint();
  if (!ep) throw new Error("LLM not configured (mock mode)");
  const started = Date.now();
  // Hard budget: never burn more than ~8s total on LLM attempts. Free-tier
  // rate-limit storms (429) must degrade to the rule fallback FAST, not stall
  // a WhatsApp user for a minute.
  const BUDGET_MS = 8000;
  const models = Array.from(new Set([ep.model, ...(ep.fallbackModels || [])]));
  // Key rotation: start where the last success happened so bursts spread
  // across keys instead of hammering key #1 into its rate limit every call.
  const keys = ep.keys?.length ? ep.keys : [ep.key];
  const base = { messages, temperature };
  if (useJson) base.response_format = { type: "json_object" };

  const overBudget = () => Date.now() - started > BUDGET_MS;

  // One HTTP attempt. Hard 20s timeout so a stalled provider can never hang a
  // conversation indefinitely — it becomes a retryable failure instead.
  const callOnce = async (model, withJson, key) => {
    const res = await fetch(`${ep.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...base, model, ...(withJson ? {} : { response_format: undefined }) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const e = new Error(`LLM ${ep.provider} HTTP ${res.status}: ${t.slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  };

  let data;
  let lastErr;
  let jsonMode = useJson;
  let lastGoodKey = -1; // rotated start index — remembered on success
  outer: for (const model of models) {
    for (let k = 0; k < keys.length; k++) {
      const ki = (keyCursor + k) % keys.length; // rotation order
      const key = keys[ki];
      for (let attempt = 0; attempt < 2; attempt++) {
        if (overBudget()) {
          log(`llm: ${BUDGET_MS}ms budget exceeded — giving up (last: ${(lastErr && (lastErr.status || lastErr.name)) || "?"})`);
          break outer;
        }
        try {
          data = await callOnce(model, jsonMode, key);
          lastGoodKey = ki;
          break outer;
        } catch (e) {
          lastErr = e;
          // 400 on json_object → drop response_format and retry the same model+key
          if (e.status === 400 && jsonMode) {
            log(`llm: response_format rejected (${model}), retrying plain`);
            jsonMode = false;
            attempt--;
            continue;
          }
          const is429 = e.status === 429;
          const retryable = is429 || e.status >= 500 || e.name === "TimeoutError" || e.name === "AbortError";
          const keyLeft = k < keys.length - 1;
          if (is429 && /quota/i.test(String(e.message))) {
            // Hard/daily quota on THIS key — the next key has its own pool.
            if (keyLeft) {
              log(`llm: QUOTA EXCEEDED on key #${ki + 1}/${keys.length} — trying next key`);
              break; // next key
            }
            log(`llm: QUOTA EXCEEDED on all ${keys.length} key(s) — falling back to rules (check GEMINI_API_KEYS/billing)`);
            break outer;
          }
          if (!retryable) {
            // 401/403 (bad/revoked key) — another key may still work; other hard errors surface
            if (keyLeft && (e.status === 401 || e.status === 403)) {
              log(`llm: HTTP ${e.status} on key #${ki + 1}/${keys.length} — trying next key`);
              break; // next key
            }
            // 404: model unavailable to this key's PROJECT (Google gates models
            // per project generation — old keys have 2.5-flash, new keys don't).
            // Try the remaining keys (one of them may have it), then the next
            // model; only abort when literally nothing is left to try.
            if (e.status === 404) {
              if (keyLeft) {
                log(`llm: ${model} unavailable on key #${ki + 1}/${keys.length} — trying next key`);
                break; // next key
              }
              if (model !== models[models.length - 1]) {
                log(`llm: ${model} unavailable — trying fallback model`);
                continue outer; // next model in chain
              }
              break outer;
            }
            break outer;
          }
          if (keyLeft && is429) {
            // Rate limit — rotate immediately, no sleep: the next key's quota is fresh.
            log(`llm: 429 on key #${ki + 1}/${keys.length} — trying next key`);
            break; // next key
          }
          if (attempt === 0 && !overBudget()) {
            const waitMs = 400 + Math.round(Math.random() * 300);
            log(`llm: ${e.status || e.name} (${model}) — retry in ${waitMs}ms`);
            await new Promise((r) => setTimeout(r, waitMs));
          } else if (models.length > 1 && model !== models[models.length - 1]) {
            log(`llm: ${e.status || e.name} — ${keyLeft ? `key #${ki + 1} exhausted, trying next key` : `${model} overloaded, trying fallback model`}`);
            break; // next key, or next model in chain when keys are exhausted
          }
        }
      }
    }
  }
  if (lastGoodKey >= 0) keyCursor = lastGoodKey; // stick with the key that worked
  if (!data) throw lastErr || new Error("LLM call failed (no models available)");
  const text = data.choices?.[0]?.message?.content ?? "";
  log(`llm: provider=${ep.provider} model=${data.model ?? ep.model} tokens=${data.usage?.total_tokens ?? "?"} ms=${Date.now() - started}`);
  return { text, model: data.model ?? ep.model };
}

export function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

export async function llmJson(system, user, { temperature = 0 } = {}) {
  if (isMock()) throw new Error("llmJson called in mock mode");
  const out = await chatCompletion(
    [
      { role: "system", content: `${system}\nRespond with valid JSON only. No markdown fences.` },
      { role: "user", content: user },
    ],
    { temperature }
  );
  const parsed = parseJson(out.text);
  if (!parsed) throw new Error("LLM returned non-JSON: " + String(out.text).slice(0, 120));
  return { ...parsed, _model: out.model };
}

export async function llmClassifyIntent(userText, historyTail = "") {
  const system = `You are the EDAY intent engine. Classify the user's request into ONE intent and extract entities.
Intent list (JSON schema):
{
 "intent": "greeting|help|offscope|service_request|track|wallet|promo|support",
 "vertical": "ride|send|chop|shop|stay|work|bills|none",
 "subtype": "airtime|data|electricity|send_package|ride_now|stay_book|shop_order|chop_order|work_request|balance|topup|none",
 "entities": { "network": "", "phone": "", "disco": "", "meter_number": "", "meter_type": "prepaid|postpaid|", "amount_ngn": 0, "pickup": "", "destination": "", "city": "", "checkin": "", "nights": 0, "order_ref": "", "package_type": "", "description": "" },
 "multi": [],            // if multiple service intents, list them
 "needs_clarification": false,
 "confidence": 0.0       // 0-1
}
Rules: Nigerian phones start 0 then 10 digits (080..., 090...). DisCos: ibedc, ikede, ekedc, aedc, bedc, eedc, phedc, kaduna. Networks: mtn, glo, airtel, 9mobile. Electricity requires meter_number (11 digits). If a payment amount is unclear or a required entity is missing set needs_clarification=true and add "missing": "<field>" into entities.
The user can refer to EARLIER turns in the History ("same", "again", "that number", "the bike", "instead", "the other one") — when they do, carry entities over from the History/context and treat them as present; only set needs_clarification if the value genuinely cannot be recovered from context.
Money mentions like "₦500", "500 naira", "N500", or a bare number in "pay 5000 electricity" -> amount_ngn=5000.\nNEVER guess or infer the network: if the user did not name it in this message (or carry it over from History as their own stated network), leave network "" and set needs_clarification=true with missing "network". Do NOT derive the network from the phone-number prefix either — ask.`;
  const out = await llmJson(system, `History: ${historyTail || "(none)"}\nUser: ${userText}`);
  return out;
}

export async function llmPlan(userText, intent, contextBundle) {
  const system = `You decompose EDAY user requests into an ordered execution plan.
Each step calls ONE tool by name. Steps run sequentially.
Allowed tools: ${allowedToolNames()}.
Return JSON: { "plan": [ { "tool": "ride_book", "args": {...} } ], "summary": "short text for the user" }.
Only include tools that exist. Payment tools are confirmed with the user automatically.`;
  const out = await llmJson(
    system,
    `Intent: ${JSON.stringify(intent)}\nContext: ${JSON.stringify(contextBundle)}\nUser: ${userText}`
  );
  return out;
}

export function allowedToolNames() {
  return [
    "wallet_balance", "wallet_topup_start", "airtime_purchase", "data_purchase", "electricity_purchase",
    "send_quote", "send_book", "send_track", "order_status", "ride_quote", "ride_book",
    "stay_search", "stay_book", "chop_order", "shop_order", "work_request", "support_ticket", "help_menu",
  ].join(", ");
}
