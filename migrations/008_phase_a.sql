-- Apply after the project's existing Phase 2-5 schema/RPCs. The original
-- migrations were applied out-of-band and are not in this repository.
-- Transactional and repeatable; run as the database owner, never via anon.
begin;
create table if not exists public.webhook_sources (
  name text primary key check (name ~ '^[A-Za-z0-9_-]{1,64}$'),
  destination_url text not null check (destination_url ~ '^https?://'),
  secret_env text not null check (secret_env ~ '^WG_SOURCE_[A-Z0-9_]+_SECRET$'),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists public.dashboard_sessions (
  id uuid primary key,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.webhook_sources enable row level security;
alter table public.dashboard_sessions enable row level security;

create or replace function public.get_webhook_source(p_name text)
returns setof public.webhook_sources language sql security definer set search_path = '' as $$
  select * from public.webhook_sources where name = p_name;
$$;
create or replace function public.list_webhook_sources()
returns setof public.webhook_sources language sql security definer set search_path = '' as $$
  select * from public.webhook_sources order by name;
$$;
create or replace function public.upsert_webhook_source(p_name text, p_destination_url text, p_secret_env text)
returns void language sql security definer set search_path = '' as $$
  insert into public.webhook_sources(name, destination_url, secret_env)
  values(p_name, p_destination_url, p_secret_env)
  on conflict(name) do update set destination_url=excluded.destination_url,
    secret_env=excluded.secret_env, enabled=true, updated_at=now();
$$;
create or replace function public.disable_webhook_source(p_name text)
returns boolean language sql security definer set search_path = '' as $$
  with changed as (update public.webhook_sources set enabled=false, updated_at=now()
    where name=p_name returning name) select exists(select 1 from changed);
$$;
create or replace function public.create_dashboard_session(p_id uuid, p_expires_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_expires_at <= now() or p_expires_at > now() + interval '12 hours 1 minute' then
    raise exception 'Invalid session expiry';
  end if;
  delete from public.dashboard_sessions where expires_at < now();
  insert into public.dashboard_sessions(id, expires_at) values(p_id,p_expires_at);
end;
$$;
create or replace function public.is_dashboard_session_active(p_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  select exists(select 1 from public.dashboard_sessions
    where id=p_id and revoked_at is null and expires_at>now());
$$;
create or replace function public.revoke_dashboard_session(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.dashboard_sessions set revoked_at=now() where id=p_id and revoked_at is null;
$$;
create or replace function public.revoke_all_dashboard_sessions()
returns void language sql security definer set search_path = '' as $$
  update public.dashboard_sessions set revoked_at=now() where revoked_at is null;
$$;

-- A signed-in dashboard is no protection when callers can invoke its RPCs
-- directly using a public anon key. Restrict BOTH old and new entry points.
revoke all on public.webhook_events, public.circuit_breakers,
  public.webhook_sources, public.dashboard_sessions from public, anon, authenticated;
grant all on public.webhook_events, public.circuit_breakers,
  public.webhook_sources, public.dashboard_sessions to service_role;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as signature from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname = any(array[
      'claim_pending_webhook_events', 'mark_webhook_event_delivered',
      'mark_webhook_event_retry', 'mark_webhook_event_skipped',
      'get_circuit_breaker_state', 'record_delivery_success', 'record_delivery_failure',
      'list_dead_lettered_events', 'replay_webhook_event', 'list_webhook_events',
      'list_circuit_breakers', 'get_webhook_source', 'list_webhook_sources',
      'upsert_webhook_source', 'disable_webhook_source', 'create_dashboard_session',
      'is_dashboard_session_active', 'revoke_dashboard_session', 'revoke_all_dashboard_sessions'
    ]) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end;
$$;
commit;
