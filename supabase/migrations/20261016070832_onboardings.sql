-- One review-history analysis per repo: avoids repeating it if GitHub redelivers events.
create table public.onboardings (
  id bigint generated always as identity primary key,
  installation_id bigint not null references public.installations (id) on delete cascade,
  repo text not null unique, -- "owner/name"
  status text not null default 'running' check (status in ('running', 'done', 'skipped', 'failed')),
  rules_proposed int,
  pr_number int,
  detail text, -- reason for the skip or the error
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.onboardings enable row level security;
grant select, insert, update, delete on public.onboardings to service_role;
