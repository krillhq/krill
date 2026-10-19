-- Index of the default branch's code: lets us spot new logic that already exists in the repo.
create table public.code_files (
  repo text not null, -- "owner/name"
  path text not null,
  installation_id bigint not null references public.installations (id) on delete cascade,
  blob_sha text not null, -- if it doesn't change, the file isn't reindexed
  indexed_at timestamptz not null default now(),
  primary key (repo, path)
);

create table public.code_chunks (
  id bigint generated always as identity primary key,
  repo text not null,
  path text not null,
  symbol text, -- name of the function or class, if detected
  start_line int not null,
  end_line int not null,
  content text not null,
  embedding extensions.vector(384) not null,
  foreign key (repo, path) references public.code_files (repo, path) on delete cascade
);
create index code_chunks_repo_idx on public.code_chunks (repo);
create index code_chunks_embedding_idx on public.code_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

alter table public.code_files enable row level security;
alter table public.code_chunks enable row level security;
grant select, insert, update, delete on public.code_files, public.code_chunks to service_role;

create function public.match_code_chunks(
  p_repo text,
  p_query_embedding extensions.vector(384),
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
