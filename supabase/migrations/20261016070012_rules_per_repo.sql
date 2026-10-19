-- Rules per repository (repo = null → the whole organization) and where they come from.
alter table public.rule_documents
  add column repo text, -- "owner/name"; null = organization-wide rules
  add column source text not null default 'manual' check (source in ('manual', 'file')),
  add column path text, -- source file, e.g. .krill/rules.md
  add column sha text; -- the file's blob sha: if it doesn't change, it isn't reprocessed

alter table public.rule_documents drop constraint rule_documents_installation_id_title_key;
alter table public.rule_documents
  add constraint rule_documents_scope_key unique nulls not distinct (installation_id, repo, title);

alter table public.rule_chunks add column repo text;
create index rule_chunks_scope_idx on public.rule_chunks (installation_id, repo);

-- The search combines the repo's rules with the organization-wide ones
drop function public.match_rule_chunks(bigint, extensions.vector, int);

create function public.match_rule_chunks(
  p_installation_id bigint,
  p_repo text,
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
    and (c.repo = p_repo or c.repo is null)
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit p_match_count;
$$;

revoke execute on function public.match_rule_chunks from public, anon, authenticated;
grant execute on function public.match_rule_chunks to service_role;
