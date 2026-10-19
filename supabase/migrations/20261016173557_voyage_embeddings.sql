-- Embeddings with Voyage (voyage-code-3, 1024 dimensions) instead of gte-small inside the function:
-- generating them in the function exhausted its CPU limit. The old embeddings aren't compatible,
-- so they're dropped: rules are reloaded from .krill/rules.md and the code is reindexed.

-- Rules
delete from public.rule_documents;
drop index public.rule_chunks_embedding_idx;
alter table public.rule_chunks alter column embedding type extensions.vector(1024);
create index rule_chunks_embedding_idx on public.rule_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

drop function public.match_rule_chunks(bigint, text, extensions.vector, int);
create function public.match_rule_chunks(
  p_installation_id bigint,
  p_repo text,
  p_query_embedding extensions.vector(1024),
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
    and (c.repo = p_repo or c.repo is null)
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit p_match_count;
$$;
revoke execute on function public.match_rule_chunks from public, anon, authenticated;
grant execute on function public.match_rule_chunks to service_role;

-- Code: each file goes pending → processing → done, in batches processed by the worker
delete from public.code_files;
drop index public.code_chunks_embedding_idx;
alter table public.code_chunks alter column embedding type extensions.vector(1024);
create index code_chunks_embedding_idx on public.code_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

alter table public.code_files
  alter column blob_sha drop not null, -- null = read the current version from the default branch
  add column status text not null default 'pending' check (status in ('pending', 'processing', 'done')),
  add column claimed_at timestamptz;
create index code_files_pending_idx on public.code_files (repo, status);

drop function public.match_code_chunks(text, extensions.vector, int);
create function public.match_code_chunks(
  p_repo text,
  p_query_embedding extensions.vector(1024),
  p_match_count int
)
returns table (id bigint, path text, symbol text, start_line int, end_line int, content text, similarity float)
language sql stable
set search_path = ''
as $$
  select c.id, c.path, c.symbol, c.start_line, c.end_line, c.content,
         1 - (c.embedding operator(extensions.<=>) p_query_embedding) as similarity
  from public.code_chunks c
  where c.repo = p_repo
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit p_match_count;
$$;
revoke execute on function public.match_code_chunks from public, anon, authenticated;
grant execute on function public.match_code_chunks to service_role;

-- Work distribution: claims a batch of pending files (or ones abandoned by a worker that died)
-- without two workers claiming the same file.
create function public.claim_code_files(p_repo text, p_limit int)
returns table (path text, installation_id bigint, blob_sha text)
language sql
set search_path = ''
as $$
  update public.code_files f
     set status = 'processing', claimed_at = now()
   where (f.repo, f.path) in (
     select c.repo, c.path from public.code_files c
      where c.repo = p_repo
        and (c.status = 'pending' or (c.status = 'processing' and c.claimed_at < now() - interval '5 minutes'))
      order by c.path
      limit p_limit
      for update skip locked
   )
  returning f.path, f.installation_id, f.blob_sha;
$$;
revoke execute on function public.claim_code_files from public, anon, authenticated;
grant execute on function public.claim_code_files to service_role;
