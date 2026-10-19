-- Architecture rules RAG per customer (GitHub installation) + a log of reviews.
create extension if not exists vector with schema extensions;

-- One customer = one installation of the GitHub App
create table public.installations (
  id bigint primary key, -- GitHub installation.id
  account_login text not null,
  created_at timestamptz not null default now()
);

create table public.rule_documents (
  id uuid primary key default gen_random_uuid(),
  installation_id bigint not null references public.installations (id) on delete cascade,
  title text not null,
  content text not null,
  created_at timestamptz not null default now(),
  unique (installation_id, title)
);

-- 384-dimension embeddings (gte-small, built into the Supabase Edge Runtime)
create table public.rule_chunks (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.rule_documents (id) on delete cascade,
  installation_id bigint not null references public.installations (id) on delete cascade,
  heading text,
  content text not null,
  embedding extensions.vector(384) not null
);
create index rule_chunks_installation_idx on public.rule_chunks (installation_id);
create index rule_chunks_embedding_idx on public.rule_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- One review per commit: avoids duplicates when GitHub redelivers the webhook
create table public.reviews (
  id bigint generated always as identity primary key,
  installation_id bigint not null references public.installations (id) on delete cascade,
  repo text not null,
  pull_number int not null,
  head_sha text not null,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  comments_posted int,
  error text,
  created_at timestamptz not null default now(),
  unique (repo, pull_number, head_sha)
);

-- No policies: only the service role (backend) can access these tables
alter table public.installations enable row level security;
alter table public.rule_documents enable row level security;
alter table public.rule_chunks enable row level security;
alter table public.reviews enable row level security;

grant select, insert, update, delete
  on public.installations, public.rule_documents, public.rule_chunks, public.reviews
  to service_role;

create or replace function public.match_rule_chunks(
  p_installation_id bigint,
  p_query_embedding extensions.vector(384),
  p_match_count int
)
returns table (id bigint, heading text, content text, similarity float)
language sql stable
set search_path = ''
as $$
  select c.id, c.heading, c.content,
         1 - (c.embedding operator(extensions.<=>) p_query_embedding) as similarity
  from public.rule_chunks c
  where c.installation_id = p_installation_id
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit p_match_count;
$$;

revoke execute on function public.match_rule_chunks from public, anon, authenticated;
grant execute on function public.match_rule_chunks to service_role;
