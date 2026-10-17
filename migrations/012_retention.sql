-- Apply after 011. Transactional and repeatable; run as the database owner.
--
-- Retention. Events are kept forever unless something deletes them; payloads
-- and headers can hold personal data, so "forever" is a liability, not a
-- feature. purge_webhook_events deletes finished events older than a cutoff,
-- by status, and reports how many went. Pending, in_progress and failed rows
-- are never touched: they are still being worked.
--
-- A null or non-positive age means "do not purge that status". Deletion is
-- batched (p_batch rows per status per call) so one call cannot hold locks
-- for long on a large table; the worker calls it hourly and the CLI can loop.
begin;

create or replace function public.purge_webhook_events(
  p_delivered_after_seconds integer,
  p_dead_lettered_after_seconds integer,
  p_batch integer default 5000)
returns table (delivered_deleted integer, dead_lettered_deleted integer)
language plpgsql security definer set search_path = '' as $$
declare
  n_delivered integer := 0;
  n_dead integer := 0;
  lim integer := greatest(coalesce(p_batch, 5000), 1);
begin
  if coalesce(p_delivered_after_seconds, 0) > 0 then
    with victims as (
      select id from public.webhook_events
       where status = 'delivered'
         and updated_at < now() - make_interval(secs => p_delivered_after_seconds)
       order by updated_at
       limit lim
    )
    delete from public.webhook_events e using victims where e.id = victims.id;
    get diagnostics n_delivered = row_count;
  end if;

  if coalesce(p_dead_lettered_after_seconds, 0) > 0 then
    with victims as (
      select id from public.webhook_events
       where status = 'dead_lettered'
         and updated_at < now() - make_interval(secs => p_dead_lettered_after_seconds)
       order by updated_at
       limit lim
    )
    delete from public.webhook_events e using victims where e.id = victims.id;
    get diagnostics n_dead = row_count;
  end if;

  return query select n_delivered, n_dead;
end;
$$;

-- Sessions: create_dashboard_session already drops expired rows at each login;
-- this also removes revoked ones and runs even when nobody logs in.
create or replace function public.purge_dashboard_sessions()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.dashboard_sessions where expires_at < now() or revoked_at is not null;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.purge_webhook_events(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.purge_webhook_events(integer, integer, integer) to service_role;
revoke all on function public.purge_dashboard_sessions() from public, anon, authenticated;
grant execute on function public.purge_dashboard_sessions() to service_role;

-- The purge scans by status and age.
create index if not exists webhook_events_status_updated_at_idx
  on public.webhook_events (status, updated_at);

commit;
