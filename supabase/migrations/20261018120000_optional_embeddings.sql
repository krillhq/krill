-- Voyage is optional: without VOYAGE_API_KEY, rules are stored without an embedding and sent in full.
alter table public.rule_chunks alter column embedding drop not null;
