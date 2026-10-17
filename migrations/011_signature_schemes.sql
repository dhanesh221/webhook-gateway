-- Apply after 010. Transactional and repeatable; run as the database owner.
--
-- Provider-native signature schemes. Each source declares how its sender signs:
--   gateway  X-Webhook-Signature t=,v1=/v2= (this project's protocol, the default)
--   github   X-Hub-Signature-256: sha256=<hmac of body>; X-GitHub-Delivery dedupes
--   stripe   Stripe-Signature: t=,v1=<hmac of "t.body">; the event id dedupes
-- Existing rows keep 'gateway', so nothing changes for them.
begin;

alter table public.webhook_sources
  add column if not exists signature_scheme text not null default 'gateway';

alter table public.webhook_sources
  drop constraint if exists webhook_sources_signature_scheme_check;
alter table public.webhook_sources
  add constraint webhook_sources_signature_scheme_check
  check (signature_scheme in ('gateway', 'github', 'stripe'));

-- PostgREST cannot pick between two overloads called with the same argument
-- names, so the 3-argument upsert is replaced rather than kept alongside.
drop function if exists public.upsert_webhook_source(text, text, text);

create or replace function public.upsert_webhook_source(
  p_name text, p_destination_url text, p_secret_env text, p_signature_scheme text default 'gateway')
returns void language sql security definer set search_path = '' as $$
  insert into public.webhook_sources(name, destination_url, secret_env, signature_scheme)
  values(p_name, p_destination_url, p_secret_env, p_signature_scheme)
  on conflict(name) do update set destination_url=excluded.destination_url,
    secret_env=excluded.secret_env, signature_scheme=excluded.signature_scheme,
    enabled=true, updated_at=now();
$$;

revoke all on function public.upsert_webhook_source(text, text, text, text) from public, anon, authenticated;
grant execute on function public.upsert_webhook_source(text, text, text, text) to service_role;

-- get_webhook_source / list_webhook_sources return setof webhook_sources and so
-- already include the new column. PostgREST caches function signatures; if the
-- API still reports the old upsert after applying this, reload the schema:
--   notify pgrst, 'reload schema';

commit;
