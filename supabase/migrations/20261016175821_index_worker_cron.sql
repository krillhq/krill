-- Safety net for the code index: every minute, wake the worker of each repo that has pending
-- or abandoned files (a worker that died before finishing its batch).
--
-- Requires two Vault secrets (not in the migration because they differ per environment):
--   select vault.create_secret('<SUPABASE_URL>/functions/v1', 'functions_url');
--   select vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY>', 'service_role_key');
create extension if not exists pg_cron;
create extension if not exists pg_net;

create function public.kick_index_workers()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_url text;
  service_key text;
  pending_repo text;
  kicked int := 0;
begin
  select decrypted_secret into base_url from vault.decrypted_secrets where name = 'functions_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'service_role_key';
  if base_url is null or service_key is null then
    return 0;
  end if;

  for pending_repo in
    select distinct f.repo from public.code_files f
     where f.status = 'pending'
        or (f.status = 'processing' and f.claimed_at < now() - interval '5 minutes')
  loop
    perform net.http_post(
      url := base_url || '/index-worker?repo=' || pending_repo,
      headers := jsonb_build_object('Authorization', 'Bearer ' || service_key),
      body := '{}'::jsonb
    );
    kicked := kicked + 1;
  end loop;
  return kicked;
end;
$$;

revoke execute on function public.kick_index_workers from public, anon, authenticated;

select cron.schedule('kick-index-workers', '* * * * *', 'select public.kick_index_workers()');
