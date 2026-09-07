// Smoke test — verify your LLM provider key works (Gemini or OpenAI-compatible).
// Usage:
//   GEMINI_API_KEY=... node scripts/smoke-llm.js gemini
//   OPENAI_API_KEY=... node scripts/smoke-llm.js openai
//   OPENAI_API_KEY=... LLM_BASE_URL=https://api.groq.com/openai/v1 node scripts/smoke-llm.js openai
import { llmEndpoint } from "../src/config.js";

const provider = process.argv[2] || "gemini";
process.env.LLM_PROVIDER = provider;

const ep = llmEndpoint();
if (!ep || !ep.key) {
  console.error(`✗ No key found for ${provider}. Set ${provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"}.`);
  process.exit(1);
}

console.log(`\n  Testing ${ep.provider} → ${ep.base}\n  model: ${ep.model}  key: ${ep.key.slice(0, 6)}…\n`);

const started = Date.now();
try {
  const res = await fetch(`${ep.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.key}` },
    body: JSON.stringify({
      model: ep.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Reply with JSON only." },
        { role: "user", content: "Say ok:true and hello in Yoruba." },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error(`✗ HTTP ${res.status}: ${t.slice(0, 400)}\n`);
    console.error("  Hints:");
    console.error("  • Is the model name correct for your key? Try LLM_MODEL=gemini-2.0-flash (or gpt-4o-mini).");
    console.error("  • Gemini keys: https://aistudio.google.com/apikey  (free tier)");
    process.exit(1);
  }
  const data = await res.json();
  const out = data.choices?.[0]?.message?.content ?? "";
  console.log(`✓ Reply (${Date.now() - started} ms): ${out}\n`);
} catch (e) {
  console.error("✗ Request failed:", e.message);
  process.exit(1);
}
