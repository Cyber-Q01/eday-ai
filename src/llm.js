// ---- LLM client — OpenAI-compatible & Gemini (Google's OpenAI-compat endpoint).
//      Providers: openai | gemini | mock (no key). Custom OpenAI-compatible
//      endpoints (LiteLLM, Groq, Together…) via LLM_BASE_URL + OPENAI_API_KEY. ----

import { isMock, llmEndpoint } from "./config.js";
import { log } from "./util.js";

async function chatCompletion(messages, { temperature = 0, useJson = true } = {}) {
  const ep = llmEndpoint();
  if (!ep) throw new Error("LLM not configured (mock mode)");
  const started = Date.now();
  const body = {
    model: ep.model,
    messages,
    temperature,
  };
  if (useJson) body.response_format = { type: "json_object" };

  const doCall = async () => {
    const res = await fetch(`${ep.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const e = new Error(`LLM ${ep.provider} HTTP ${res.status}: ${t.slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  };

  // Retry transient provider overloads (429/5xx) with exponential backoff.
  const attempt = async (n) => {
    try {
      return await doCall();
    } catch (e) {
      const retryable = e.status && (e.status === 429 || e.status >= 500) && n < 3;
      if (retryable) {
        const waitMs = Math.round(1000 * 2 ** n + Math.random() * 500);
        log(`llm: HTTP ${e.status} — retry ${n + 1}/3 in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        return attempt(n + 1);
      }
      throw e;
    }
  };

  let data;
  try {
    data = await attempt(0);
  } catch (e) {
    // some providers/models reject response_format json_object → retry plain
    if (useJson && e.status === 400) {
      body.response_format = undefined;
      delete body.response_format;
      log(`llm: response_format rejected, retrying plain (${e.message.slice(0, 120)})`);
      data = await attempt(0);
    } else throw e;
  }
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
