// ---- LLM client — OpenAI-compatible & Gemini (Google's OpenAI-compat endpoint).
//      Providers: openai | gemini | mock (no key). Custom OpenAI-compatible
//      endpoints (LiteLLM, Groq, Together…) via LLM_BASE_URL + OPENAI_API_KEY. ----

import { isMock, llmEndpoint } from "./config.js";
import { log } from "./util.js";

async function chatCompletion(messages, { temperature = 0, useJson = true } = {}) {
  const ep = llmEndpoint();
  if (!ep) throw new Error("LLM not configured (mock mode)");
  const started = Date.now();
  // Hard budget: never burn more than ~8s total on LLM attempts. Free-tier
  // rate-limit storms (429) must degrade to the rule fallback FAST, not stall
  // a WhatsApp user for a minute.
  const BUDGET_MS = 8000;
  const models = Array.from(new Set([ep.model, ...(ep.fallbackModels || [])]));
  const base = { messages, temperature };
  if (useJson) base.response_format = { type: "json_object" };

  const overBudget = () => Date.now() - started > BUDGET_MS;

  // One HTTP attempt. Hard 20s timeout so a stalled provider can never hang a
  // conversation indefinitely — it becomes a retryable failure instead.
  const callOnce = async (model, withJson) => {
    const res = await fetch(`${ep.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.key}` },
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
  outer: for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (overBudget()) {
        log(`llm: ${BUDGET_MS}ms budget exceeded — giving up (last: ${(lastErr && (lastErr.status || lastErr.name)) || "?"})`);
        break outer;
      }
      try {
        data = await callOnce(model, jsonMode);
        break outer;
      } catch (e) {
        lastErr = e;
        const retryable = e.status === 429 || e.status >= 500 || e.name === "TimeoutError" || e.name === "AbortError";
        // 400 on json_object → drop response_format and retry the same model
        if (e.status === 400 && jsonMode) {
          log(`llm: response_format rejected (${model}), retrying plain`);
          jsonMode = false;
          attempt--;
          continue;
        }
        if (!retryable) break outer; // hard error (401, bad request...) — surface it
        if (attempt === 0 && !overBudget()) {
          const waitMs = 400 + Math.round(Math.random() * 300);
          log(`llm: ${e.status || e.name} (${model}) — retry in ${waitMs}ms`);
          await new Promise((r) => setTimeout(r, waitMs));
        } else if (models.length > 1 && model !== models[models.length - 1]) {
          log(`llm: ${e.status || e.name} — ${model} overloaded, trying fallback model`);
          break; // next model in chain
        }
      }
    }
  }
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
Money mentions like "₦500", "500 naira", "N500", or a bare number in "pay 5000 electricity" -> amount_ngn=5000. "buy data" default network mtn.`;
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
