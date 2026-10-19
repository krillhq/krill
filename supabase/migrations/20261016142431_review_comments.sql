-- Review comments written by people: the raw material for continuous learning.
create table public.review_comments (
  id bigint primary key, -- the comment's GitHub id
  installation_id bigint not null references public.installations (id) on delete cascade,
  repo text not null, -- "owner/name"
  pr_number int not null,
  author text not null,
  body text not null,
  path text not null,
  diff_hunk text not null,
  url text not null,
  created_at timestamptz not null,
  learned boolean not null default false -- already used to propose rules
);

create index review_comments_pending_idx on public.review_comments (repo, learned);

alter table public.review_comments enable row level security;
grant select, insert, update, delete on public.review_comments to service_role;
