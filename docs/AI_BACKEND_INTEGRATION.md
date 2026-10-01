# AI ⇄ Backend Integration — Design (v1)

Decisions locked before implementation. Scope: real **Eday Send + Bills** through the AI
layer, **authenticated-only conversations**, **phone-match linking** (WhatsApp auto,
Telegram via 4-digit code), **"continue in-app" handoff**, and a **tone pass** (fewer
emojis). Governing rule carried from the main repos: the ledger trigger is the only
integrity gate — the AI layer may *initiate* money movement, never *define* it.

---

## 1 · Trust model — who holds what

| Component | Holds | Never holds |
|---|---|---|
| eday-ai (Railway/Render) | `BACKEND_INTERNAL_KEY` (shared secret), `SIGNING_SECRET`, anon Supabase key for AI-schema storage | `SUPABASE_SERVICE_ROLE_KEY` |
| `ai-actions` edge fn | service role (runtime-injected) | — |
| Mobile/web app | user JWT | anything server-side |

Every AI tool call flows: `tools.js → POST {BACKEND_INTERNAL_URL}/functions/v1/ai-actions`
(with `Idempotency-Key: ai-<runId>-<tool>`) — **the exact contract `tools.js` already
implements**; no orchestrator changes needed for transport.

## 2 · `ai-actions` edge function (mobile repo: `supabase/functions/ai-actions/`)

Contract: `POST { action, args, user_id }` → result JSON. Failures close as
`{ error }` with 4xx/5xx so `tools.js` surfaces them as chat messages.

**Action allowlist (no dynamic dispatch):** `send_quote`, `send_book`, `send_track`,
`wallet_balance`, `bill_validate`, `airtime_purchase`, `data_purchase`,
`electricity_purchase`, `send_handoff` (§5). Unknown action → 400.

**Guards, in order:**
1. **Timing-safe secret check** — `x-internal-key` header vs `BACKEND_INTERNAL_KEY`
   (from Supabase vault/env) via constant-time compare; wrong key → 401, no body echo.
2. **user_id must be a real user** — verify a `profiles` row exists for the UUID and
   (defence-in-depth) that `linked_channels` has an active row for
   `(user_id, channel)` passed in `args.channel`. A fabricated UUID fails here.
3. **Per-user rate limits** — token-bucket in a `ai_rate_limits` helper table
   (user_id, action, window_start, count): payments ≤ 10/hour, reads ≤ 60/hour.
4. **Arg schema validation per action** (types, ranges, E.164 shape for phones,
   meter format) — reject before touching RPCs.
5. **Money RPCs only** — the function maps actions to existing DB functions:
   - `send_quote` → `quote-send` logic already in `create-order` (haversine + fare fn) —
     call `begin_send_order`'s pricing math via a small shared SQL fn or repeat the
     pure formula (no DB writes either way).
   - `send_book` → `begin_send_order(p_user_id := user_id, p_reference := args.reference …)`
     — atomic debit + ledger row; unique reference = idempotency (retries safe).
   - `send_track` → `select … from orders where reference = … and user_id = user_id`.
   - `airtime/data/electricity` → `begin_bill_vend(...)` + VTPass vend flow **reusing
     `vtpass-proxy`'s vend logic** (either extract to a shared module or have
     `ai-actions` proxy the same three-step vend: begin → vendor → confirm/reverse).
     `bill_validate` maps to the existing meter/IUC validation action.
   - `wallet_balance` → `select balance from wallets where user_id = user_id`.
6. **Audit mirror** — every accepted call appends to `ai_audit` (entry: action, user_id,
   reference, outcome, latency) so `/v1/audit` and the DB agree.

**Env/secrets:** `BACKEND_INTERNAL_KEY`, `SIGNING_SECRET` (vault). eday-ai sets the same
two values; `TOOL_MODE=http`, `BACKEND_INTERNAL_URL=https://<ref>.supabase.co/functions/v1`.

## 3 · Authentication gate — conversations only for linked users

**Identity resolution (eday-ai, new `auth.js`):**
`resolveUser(channel, externalId)` → real auth UUID or null, cached per process (5 min
TTL) with write-through on link events.

- WhatsApp: `externalId = wa_<E.164>` → match `linked_channels(channel='whatsapp', external_id)`.
  Meta delivers the sender's real phone, and `profiles.phone` is unique —
  **phone-match linking is automatic** (§4).
- Telegram: `externalId = tg_<chatId>` → `linked_channels(channel='telegram', …)`;
  Telegram never exposes phones, so linking is by **4-digit code** (§4).

**Gate rule:** unlinked sender gets exactly one reply —
"This number isn't linked to an eday account. Open the app → Channels → connect."
No session, no memory, no tools, no retry loops (rate-limited 1 reply/10 min per sender).
Once linked: all AI memory/audit keys become the **auth UUID**, so app + chat are one
account (the "one history, one wallet" promise from `channels/link.tsx`).

**Schema (mobile repo migration):**
```sql
alter table linked_channels drop constraint linked_channels_user_id_channel_key;
alter table linked_channels
  add constraint linked_channels_channel_external_key unique (channel, external_id);

create table channel_link_codes (
  code        text primary key,          -- 4 digits, crypto-random from 10k space
  user_id     uuid not null references profiles(id) on delete cascade,
  channel     channel_kind not null default 'telegram',
  expires_at  timestamptz not null default now() + interval '10 minutes',
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index channel_link_codes_user_idx on channel_link_codes (user_id, created_at desc);

create or replace function public.create_channel_link_code()
returns text … -- service-role only; rate-limited (≤5 open codes/user), 10-min expiry
create or replace function public.claim_channel_link_code(p_code text, p_external_id text, p_channel channel_kind)
returns uuid …  -- service-role only; single-use UPDATE … where used_at is null and expires_at > now();
                -- upserts linked_channels (on conflict (channel, external_id) reassign to new user)
```
`security_best_practices` note: 4 digits is a 1-in-10,000 guess — the **10-minute
expiry, single-use UPDATE, and service-role-only execution** are what make it safe;
the claim RPC never runs with client credentials, and eday-ai reaches it only through
`ai-actions` with the shared secret.

## 4 · Linking flows

- **WhatsApp (auto):** first message → eday-ai asks `ai-actions: link_by_phone`
  (allowlisted, secret-guarded, normalized E.164) → DB matches `profiles.phone` →
  lazy `linked_channels` row → user resolves → conversation opens. No UI needed.
  Unmatched numbers get the standard "not linked" reply.
- **Telegram (code):** app `channels/link.tsx` already designs this screen —
  wire it: button → `create_channel_link_code()` (user JWT) → show 4 digits →
  user sends code to bot → eday-ai calls `claim_channel_link_code` via `ai-actions`
  → bot confirms "Linked. You're chatting as <first name>." → `linked.tsx` reflects it.

## 5 · "Continue in-app" choice — signed deeplink handoff

During a send (and later bills) conversation, after the AI has a **confirmed quote**:

> Reply 1 to continue here, or 2 and I'll hand you to the app to finish.

- **"1"** → book in-chat as normal (confirm gate already ran on the quote step).
- **"2"** → eday-ai calls `ai-actions: send_handoff { user_id, quote params }` →
  returns `{ deeplink, token }`; bot replies with a tappable
  `projecteday://send/matching?ref=<ref>&t=<token>`.

**Token (handoff continuity, not authority):** `v1.<b64url payload>.<b64url sig>`,
payload `{ uid, exp }`, HMAC-SHA256 with `SIGNING_SECRET`, **10-minute expiry**,
**single-use** (redeem marks used in `ai_handoff_tokens`), issued ≤10/hour/user.
The app's first authenticated call carrying the token verifies signature + expiry +
single-use server-side (`ai-actions: send_handoff_redeem` or inside the matching page's
status endpoint). The token grants nothing on its own — money still moves only through
`begin_send_order` under the user's identity; it just lets the app resume the exact
quote/checkout state (mirrors the web `lib/sendFlow.ts` sessionStorage checkpoint).

**Mobile side:** wire `channels/*` screens as in §4; the send screens already exist —
deeplink lands on the matching/checkout screen with `ref` prefilled, "Continue in chat"
stays available. Parse via `expo-linking` (scheme `projecteday` already in `app.json`).

## 6 · Tone pass (fewer emojis)

Single source of truth: orchestrator reply builders + channel acks.
- Remove decorative emojis from all reply templates; keep at most one ✅ on successful
  payments, one ⚠️ style marker on irreversible actions.
- No emoji in error/help/system texts. Update tests that assert emoji-laden strings.

## 7 · Security checklist (enforced in code review of this work)

- [ ] Shared secret compared constant-time; 401s identical for bad-key and bad-route.
- [ ] No service-role key outside edge functions; eday-ai never gets it.
- [ ] Every action validated against a per-action schema before RPC dispatch.
- [ ] user_id provenance: UUID must exist in `profiles` + active `linked_channels` row.
- [ ] Payment tools: confirm gate in-chat **and** idempotency key; declines charge nothing.
- [ ] Link codes: 10-min expiry, single-use, service-role-only claim, ≤5 open/user.
- [ ] Handoff tokens: signed, 10-min, single-use, rate-limited, zero wallet authority.
- [ ] Phones/meters masked in all logs/audit (existing `util.js` mask kept).
- [ ] Rate limits per user+action in DB (survives restarts, multi-instance safe later).
- [ ] Audit mirror row for every accepted `ai-actions` call.

## 8 · As-built notes (updates to §1–§2)

- **Transport:** `ai-actions` does NOT call DB RPCs directly for money — it proxies
  `create-order` (`quote-send-ai`, `send-ai`) and `vtpass-proxy` (`verify-electricity-ai`,
  `vend-ai`), which gained an **internal-actor mode**: request carries the shared secret
  (`x-internal-key`, constant-time compared) and acts FOR the pre-validated `user_id`.
  This project's service key is the new non-JWT format, so there is no role claim —
  the shared secret alone gates internal-actor mode, and it exists only in the three
  edge functions' secrets + the AI service env. Money logic stays in ONE place each
  (begin_send_order / begin_bill_vend / refund_bill) — zero duplication.
- **Geocoding:** the edge runtime's egress currently cannot reach Nominatim, so
  `geocode_cache` is seeded by `scripts/seed-geocache.js` (30 major NG hubs, re-runnable)
  and quotes are served cache-first — faster anyway.
- **Handoff (§5 revision):** the deeplink carries ADDRESSES ONLY — no token, no
  authority. The app re-quotes and the user pays via their own authenticated checkout.
  The signed single-use token machinery (send_handoff / redeem) is deployed for future
  resume-audit use.
- **Tests:** `npm test` is cross-platform via `--env-file-if-exists=test.env`.

## 9 · Original execution order

1. Tone pass + tests (eday-ai).
2. Migration: `linked_channels` constraint + `channel_link_codes` + link RPCs (mobile repo; needs `db push`/SQL editor from user side).
3. eday-ai `auth.js` gate + UUID-keyed memory (mock mode tests updated).
4. `ai-actions` edge function + `tools.js` env wiring (mock fallback stays for tests).
5. Telegram link flow end-to-end (bot ↔ app code) + WhatsApp auto-match.
6. Send handoff (§5) + mobile deeplink landing.
7. Full test pass both sides; then bills tool go-live behind the same gate.

Checkpoint with the user after each numbered step.
