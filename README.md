# EDAY AI Orchestration Layer

A deployable AI orchestration layer for the EDAY super-app ecosystem (Ride · Send · Chop · Shop · Stay · Work · Bills · Wallet).
It understands natural-language requests, plans multi-step tasks, executes through a permissioned tool layer with **payment confirmations**, keeps per-user memory, and writes a full audit trail — while remaining **fully testable with zero API keys** (built-in mock mode + simulated EDAY backend).

> Architecture context: `plan.md` (this repo's sibling plan) describes the full AI layer design. The app backend (Supabase) is tracked separately in `plan-backend.md`; this service calls the backend's action endpoints (`TOOL_MODE=http`) once they're live, and ships with a **simulated backend** so it works standalone today.

## Quickstart (local, no keys needed)

```bash
node --version   # >= 18
npm start        # -> http://localhost:3000
```

Open **http://localhost:3000/** — a chat playground. Try:
- `buy 500 naira mtn airtime for 08031234567` → confirm → done
- `pay 5000 electricity for meter 41234567890` → token returned
- `send a package from Ikeja Lagos to Yaba Lagos` → quote → `book it` → confirm
- `book a ride from Ikeja to the airport` → `book the car` → confirm
- `find a hotel in Ibadan for 1 night` → pick `1` → confirm
- `what is my wallet balance?`

Test data: meters `41234567890` (IBEDC), `51234567890` (EKEDC), `61234567890` (IKEDC). Every new user gets a ₦50,000 mock wallet. Payments **always ask for confirmation** unless `SKIP_CONFIRM=true` (testing only).

## Social channels — ONE host, all your messengers

This build ships **WhatsApp and Telegram together** on the same deployment (plus the web
playground): one URL, one Railway service, the same EDAY brain, per-user memory and
confirmations on every channel. Each channel activates when its env vars are set; the
boot log prints the state of both.

| Channel | Endpoint | Setup gate |
|---|---|---|
| WhatsApp (Meta Cloud API) | `GET/POST /webhook/whatsapp` | Needs the Meta app **published** for real-user traffic (dev mode delivers only dashboard test payloads) |
| Telegram (Bot API) | `POST /webhook/telegram` | **None** — free @BotFather bot, works immediately |
| Web playground + `/v1/chat` API | `GET /`, `POST /v1/chat` | None |

Check both: `GET /v1/meta` → `whatsapp_connected`, `telegram_connected`, `channels`.

## Connect WhatsApp (Meta Cloud API) — free

The service ships a WhatsApp bridge: a real WhatsApp number can chat with EDAY (airtime, electricity, send, ride, stay, chop, shop, work, wallet — same brain, confirm-gated payments). Endpoints:

- `GET /webhook/whatsapp` — Meta verification handshake
- `POST /webhook/whatsapp` — inbound messages → reply (user-initiated 24 h window; no templates needed for testing)

### Meta side (once, ~10 min, free)
1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App** → type **Business** → pick the EDAY Business portfolio (create one if asked) → add the **WhatsApp** product.
2. In **WhatsApp → API Setup** you get: a **test phone number**, a **Phone number ID**, a **Temporary access token** (24 h — use a **System user** token for production: Business settings → System users → add user → assign your app → *whatsapp_business_messaging* permission → generate token).
3. In **WhatsApp → Configuration → Webhook → Edit**, fill:
   | Field | Value |
   |---|---|
   | **Callback URL** | `https://<your-service>.onrender.com/webhook/whatsapp` (Railway/Render URL + path) |
   | **Verify token** | any secret string you choose (must equal env `WHATSAPP_VERIFY_TOKEN`) |
4. Click **Verify and save** → Meta calls the GET endpoint and gets your challenge back.
5. On the same page click **Manage → Subscribe** to the **messages** field.
6. Add your phone: **API Setup → To:** add your WhatsApp number (or message the business number once from your phone).

### EDAY side (env vars)
`WHATSAPP_VERIFY_TOKEN` (required) · `WHATSAPP_TOKEN` · `WHATSAPP_PHONE_ID` · `WHATSAPP_APP_SECRET` (optional) · `WHATSAPP_DRY_RUN` (testing only) · `WHATSAPP_ACK` (default true — sends an instant "one moment" text when a reply takes >2s; the Cloud API has no typing indicator, so this is EDAY's stand-in) · `WHATSAPP_ACK_TEXT`. Each sender maps to user `wa_<number>` with a sticky session — memory and confirmations persist per phone. Message bursts are processed in order.

Check it's live: `GET /v1/meta` → `whatsapp_connected: true`. No API key needed on the webhook itself (Meta cannot add headers).

## Connect Telegram — same host, no approval

Bots on Telegram need no publishing, whitelist, or verification — anyone can chat with the
bot once its webhook points at your host.

1. In Telegram, message **@BotFather** → `/newbot` → pick a name/username → copy the **bot token**.
2. Register the webhook (one command, run anywhere):
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-service>.up.railway.app/webhook/telegram"
   # optional auth: append &secret_token=<yourstring> and set TELEGRAM_SECRET=<yourstring>
   ```
3. Env vars on the deploy: `TELEGRAM_BOT_TOKEN` (required) · `TELEGRAM_SECRET` (optional) ·
   `TELEGRAM_ACK` (default true — sends Telegram's native "typing…" while EDAY works) ·
   `TELEGRAM_DRY_RUN`.

**Test loop:** open your bot in Telegram → **Start** → `help`, `hello`,
`buy 500 naira mtn airtime for 08031234567`, `what is my wallet balance?` — each chat maps
to user `tg_<chatId>`, memory and confirmations persist per user.

## API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness + current mode (`llm_mode`, `model`, `tool_mode`) |
| `GET /` | Chat playground (HTML) |
| `POST /v1/chat` | `{ session_id?, user_id?, channel?, message }` → `{ session_id, reply, actions, pending_confirm }` |
| `GET /v1/memory?user_id=` | Recall per-user preferences/episodes |
| `DELETE /v1/memory?user_id=` | User erases their memory |
| `GET /v1/audit?limit=` | Recent audit entries |
| `GET /v1/meta` | Mode info |

```bash
curl -s localhost:3000/v1/chat -H 'Content-Type: application/json' \
  -d '{"session_id":"s1","user_id":"me","message":"buy 500 naira mtn airtime for 08031234567"}'
```

Optional protection: set `API_KEY=...`, then send `Authorization: Bearer <key>`.

## Using a real LLM — Gemini (recommended for testing) or OpenAI-compatible

**Gemini (free tier — great for testing):**
1. Get a key: https://aistudio.google.com/apikey (free tier included).
2. `export GEMINI_API_KEY=...` (optionally `LLM_MODEL=gemini-2.5-flash` or a model your key supports).
3. Verify: `node scripts/smoke-llm.js gemini` → expect a JSON reply.
4. `npm start` → `/health` shows `llm_provider: "gemini"`. The service auto-uses Google's OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`).

**OpenAI / custom (LiteLLM, Groq, Together…):**
- `OPENAI_API_KEY=...` (+ `LLM_BASE_URL` for non-OpenAI endpoints, `LLM_MODEL` to pick the model).
- Verify: `node scripts/smoke-llm.js openai`.

**Provider selection** (`LLM_PROVIDER`): `auto` (default) = OpenAI key → Gemini key → mock; or force `mock` / `openai` / `gemini`. No key = full mock loop (same confirmations/tools/audit).

## Persisting memory (incl. VECTOR memory) & audit in your Supabase "Eday" project

The service stores per-user memory + the audit trail in your existing Supabase project — including **semantic vector memory** via the `pgvector` extension (Supabase has it built in):
1. Open your Eday Supabase project → **SQL Editor** → run everything in `supabase/schema.sql`. It creates: `ai_memory` (preferences) · `ai_episodes` (history) · **`ai_embeddings` (vector(768) + HNSW cosine index + `ai_embedding_add` / `ai_memory_search` RPCs)** · `ai_audit` · `ai_sessions` — additive and service-role only; your app tables are untouched.
2. Project Settings → API → copy **Project URL** and **service_role** key.
3. `export SUPABASE_URL=https://<ref>.supabase.co`
   `export SUPABASE_SERVICE_ROLE_KEY=eyJ...`   (⚠️ server-side only — never in frontend code or commits)
4. Restart → `/health` shows `store_backend: "supabase"`.

What vector memory gives you (once connected):
- Every completed action is embedded and stored (`kind='episodic'`) — embedding provider: **Gemini `gemini-embedding-001`, pinned to 768-dim** (`batchEmbedContents` + `outputDimensionality`, free tier) when `GEMINI_API_KEY` is set, otherwise a **deterministic mock embedder** (same 768-dim) so the whole pipeline works with no keys.
- Ask semantically: `GET /v1/memory/search?user_id=…&q=…` → top-5 similar memories via the HNSW index. ("What did I buy last week?" ≈ works against stored episodes.)
- `DELETE /v1/memory?user_id=` wipes preferences, episodes AND embeddings (user right-to-erasure).
- If Supabase is unreachable the service auto-falls back to in-memory and logs a warning.

## LiteLLM proxy (FREE — self-hosted)

**Yes, LiteLLM is free**: it's MIT open-source, so the **self-hosted proxy costs $0** (only their managed cloud is paid — we don't use it). It puts one OpenAI-compatible URL in front of Gemini/OpenAI/Groq/etc. with routing, retries, fallbacks and per-day cost caps.

- **Local:** `docker compose up --build` → starts LiteLLM on `:4000` + the AI service on `:3000` wired to it (`LLM_PROVIDER=litellm`, model alias `gemini-flash`). Add keys in `.env` (`GEMINI_API_KEY`, `OPENAI_API_KEY`, optional `GROQ_API_KEY`).
- **Render:** the blueprint includes an optional `eday-litellm` service (`litellm/Dockerfile`) — deploy it, then point `eday-ai` at `https://eday-litellm.onrender.com/v1` with `LLM_PROVIDER=litellm` + the master key.
- Routing config lives in `litellm/config.yaml` (free tier guardrail: `max_budget: 2.0/day`).
- Run it WITHOUT LiteLLM too — set `LLM_PROVIDER=gemini` (direct) or none at all (mock).

## Deploy to Render

1. Push this folder to a GitHub repo.
2. Render dashboard → **New → Blueprint** (uses `render.yaml`) — or **New Web Service** → connect repo → runtime **Docker** → deploy.
3. Set secrets in the Render dashboard: `OPENAI_API_KEY` (optional — mock works), `API_KEY` (optional).
4. Health check: `GET /health` returns 200. Open `https://<your-service>.onrender.com/` for the playground.

### Local Docker
```bash
docker build -t eday-ai . && docker run -p 3000:3000 -e LLM_MODE=mock eday-ai
```

## Keeping the app awake (Railway & co.)

Railway's app-sleeping ("Serverless") puts a service to sleep after **~10 minutes with no
outbound traffic** — and inbound pings (webhooks, external uptime monitors like
cron-job.org/UptimeRobot) do **not** keep it awake; they only wake a service after it has
already slept, and it sleeps again ~10 min later. The fix is outbound activity started
*inside* the service: EDAY ships a built-in keep-awake heartbeat that pings its own public
URL every few minutes.

- Enabled automatically when a public URL is known: `RAILWAY_PUBLIC_DOMAIN` (or
  `RAILWAY_STATIC_URL`) is set by Railway — no env vars needed.
- Override the target with `KEEPALIVE_URL=https://…` (any URL; e.g. point it at the app
  itself). Set `KEEPALIVE_URL=off` to disable.
- Interval: `KEEPALIVE_INTERVAL_MIN` (default 4 — must stay under the ~10 min sleep
  window; minimum 1).
- Verify: boot log prints `[keepalive] heartbeat ON — outbound ping to … every 4 min`.

If you'd rather not pay the tiny heartbeat traffic, the alternative is Railway service
settings → **Serverless → disable** (keeps the container running 24/7 on paid plans).

## EDAY service coverage (all verticals in ONE assistant)

| Vertical | Tools | Try saying |
|---|---|---|
| 🚗 **Ride** | `ride_quote`, `ride_book` (Bike/Car/Premium offers) | “book a ride from Ikeja to Lekki” → pick a type |
| 📦 **Send** | `send_quote`, `send_book`, `send_track` | “send a package from Ikeja to Yaba” → “book it” |
| 🍛 **Chop** | `chop_order` (menu matching, per-city vendors) | “order jollof rice and chicken in Ibadan” |
| 🛍️ **Shop** | `shop_order` (catalog matching) | “buy a smartwatch” |
| 🏨 **Stay** | `stay_search`, `stay_book` | “find a hotel in Ibadan for 1 night” → pick number |
| 🛠️ **Work** | `work_request` (pro matching) | “I need a plumber in Ibadan” |
| 💡 **Bills** | `airtime_purchase`, `data_purchase`, `electricity_purchase` | “buy ₦500 MTN airtime for 08031234567” |
| 💰 **Wallet** | `wallet_balance`, `wallet_topup_start` | “top up my wallet with ₦20,000” |

Every payment tool is confirm-gated (“Reply Yes to confirm”) and every completed action is stored as a memory episode + vector embedding (see Supabase section). All six verticals currently run against the simulated EDAY middleware (`TOOL_MODE=mock`) so the orchestration layer is fully testable before the real backend contract goes live.

## Behaviour guarantees (non-negotiable)

- **Every payment tool requires explicit user confirmation** in-chat before execution (per-action, unless `SKIP_CONFIRM=true` for automated tests only).
- **Declines charge nothing.** Confirmation is stateful per session; "no" cancels.
- **Never fake:** with `TOOL_MODE=http` + `BACKEND_INTERNAL_URL/KEY` it calls the real backend action endpoints (with `Idempotency-Key`); otherwise the simulated backend (clearly labelled) runs.
- **Audit everything:** each intent + tool call is logged (console JSON + `/v1/audit`); phones/meters are masked in audit/intent logs.
- **User memory is deletable**: `DELETE /v1/memory?user_id=…`.
- **Graceful fallbacks**: unknown intents → polite refusal + help; missing info → asks one focused question; empty wallet → tells you to top up and retry.

## Tests

```bash
npm test        # 12 integration tests — confirm gates, wallet safety, races, memory (no keys needed)
npm run demo    # scripted terminal conversation
```

## Structure

```
src/
  server.js        HTTP: health, /v1/chat, memory, audit, playground
  orchestrator.js  the conversation state machine + confirm gate + plans
  intent.js → mockIntent.js   LLM intent (structured JSON) w/ deterministic fallback
  llm.js           OpenAI-compatible client (works with LiteLLM/Groq/…)
  tools.js         tool registry: permissions, confirm rules, execution + idempotency
  backend.js       SIMULATED EDAY backend (wallet/orders/bills/send/ride/stay) — swap for real via TOOL_MODE=http
  memory.js        per-user prefs + episodes (file persistence optional)
  audit.js         JSON audit trail
  config.js · util.js
tests/             node --test integration suite
scripts/demo.js    scripted demo
```

## Known limitations (this v0.1)

- Single-instance in-memory state (sessions/orders/wallets). Fine for Render single web service + testing; multi-instance + Postgres/Redis comes with the real backend integration.
- Mock intent covers the demo verticals (bills, send, ride, stay, wallet, track); a real LLM extends it to chop/shop/work/multi-step travel without code changes.
- Simulated "orders" auto-advance (picked up → in transit → delivered) via timers when the server runs; in tests timers are disabled (`AUTO_PROGRESS=0`).
