// Terminal demo: runs a scripted conversation against the orchestration loop (mock mode).
// Usage: npm run demo
import { handleMessage } from "../src/orchestrator.js";
import { audit } from "../src/audit.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = { session_id: "demo_session", user_id: "demo_user", channel: "terminal" };

const script = [
  "hello",
  "what can you do?",
  "buy 500 naira mtn airtime for 08031234567",
  "yes",
  "pay 2000 electricity for meter 51234567890",
  "no",
  "send a package from Ikeja Lagos to Yaba Lagos",
  "book it",
  "yes",
  "book a ride from Yaba to the airport",
  "book the car",
  "yes",
  "find a hotel in Ibadan for 1 night",
  "1",
  "yes",
  "track ORD_demo123", // deliberately unknown → graceful error path
  "transfer 2 million naira to my uncle", // off-scope guard
];

console.log("\n  ┌──────────────────────────────────────────────┐");
console.log("  │   EDAY AI ORCHESTRATION — TERMINAL DEMO       │");
console.log("  └──────────────────────────────────────────────┘\n");

for (const msg of script) {
  const out = await handleMessage({ ...session, message: msg });
  console.log(`\n🧑 You: ${msg}`);
  console.log(`🤖 EDAY: ${out.reply.replace(/\n/g, "\n        ")}`);
  if (out.actions?.length) console.log(`   [quick replies: ${out.actions.map((a) => a.title).join(" | ")}]`);
  await sleep(120);
}

const entries = audit.recent(5).length;
console.log(`\n\n  Audit entries recorded: ${entries} (see server logs / /v1/audit)\n`);
console.log("  To speak with a real LLM: set OPENAI_API_KEY and rerun.\n");
