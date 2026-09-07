-- =============================================================
-- EDAY AI orchestration — additive schema for the Supabase BaaS
-- Run this in your Supabase project (SQL Editor) ONE TIME.
-- These tables are used ONLY by the AI layer (server-side, via the
-- service_role key). They never touch your app tables.
-- RLS is enabled; access is service-role only.
-- =============================================================

-- ---------- pgvector extension (enabled; used by ai_embeddings) ----------
create extension if not exists vector;

-- ---------- Memory: structured preferences ----------
create table if not exists public.ai_memory (
  user_id    text not null,
  key        text not null,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------- Memory: episodic (recent conversations, plain) ----------
create table if not exists public.ai_episodes (
  id         bigint generated always as identity primary key,
  user_id    text not null,
  summary    text not null,
  at         timestamptz not null default now()
);
create index if not exists ai_episodes_user_idx on public.ai_episodes (user_id, at desc);

-- ---------- Memory: vector embeddings for semantic recall ----------
-- Dimension 768 matches Gemini `gemini-embedding-001` (pinned via outputDimensionality) AND the built-in mock
-- embedder. (If you later switch to OpenAI text-embedding-3-small [1536],
-- recreate this table with vector(1536) — see src/embed.js.)
create table if not exists public.ai_embeddings (
  id         bigint generated always as identity primary key,
  user_id    text not null,
  kind       text not null default 'episodic',
  content    text not null,
  embedding  vector(768) not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_embeddings_hnsw_idx
  on public.ai_embeddings using hnsw (embedding vector_cosine_ops);

-- ---------- Audit trail (append-only; written by the AI service) ----------
create table if not exists public.ai_audit (
  id    text primary key,
  at    timestamptz not null default now(),
  entry jsonb not null
);
create index if not exists ai_audit_at_idx on public.ai_audit (at desc);

-- ---------- Sessions (conversation state — reserved) ----------
create table if not exists public.ai_sessions (
  session_id text primary key,
  user_id    text not null,
  channel    text,
  state      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- RPC helpers (PostgREST calls these with service key) ----------
-- Add an embedding row. p_embedding is the vector literal, e.g. "[0.1,0.2,...]"
create or replace function public.ai_embedding_add(
  p_user text, p_kind text, p_content text, p_embedding text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.ai_embeddings (user_id, kind, content, embedding)
  values (p_user, p_kind, p_content, p_embedding::vector);
end $$;

-- Semantic recall: cosine similarity search for one user, top-k
create or replace function public.ai_memory_search(
  p_user text, p_query_embedding text, p_k int default 5
) returns table (content text, kind text, similarity double precision)
language sql security definer set search_path = public as $$
  select e.content, e.kind, 1 - (e.embedding <=> p_query_embedding::vector) as similarity
  from public.ai_embeddings e
  where e.user_id = p_user
  order by e.embedding <=> p_query_embedding::vector
  limit p_k;
$$;

-- ---------- Security ----------
alter table public.ai_memory     enable row level security;
alter table public.ai_episodes   enable row level security;
alter table public.ai_embeddings enable row level security;
alter table public.ai_audit      enable row level security;
alter table public.ai_sessions   enable row level security;

-- RPCs are service-role only (the AI service calls them with the service key)
revoke all on function public.ai_embedding_add(text, text, text, text) from public, anon, authenticated;
revoke all on function public.ai_memory_search(text, text, int) from public, anon, authenticated;
grant execute on function public.ai_embedding_add(text, text, text, text) to service_role;
grant execute on function public.ai_memory_search(text, text, int) to service_role;
