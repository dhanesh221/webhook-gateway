-- Apply after 008. Transactional and repeatable; run as the database owner.
-- Nothing here changes existing rows' behaviour.
begin;

-- 1. Exact request bytes, so delivery does not round-trip through JSON.
alter table public.webhook_events add column if not exists raw_body text;

-- 2. When an event was last claimed. A trigger stamps it, so this works without
--    editing claim_pending_webhook_events (which was applied out-of-band).
alter table public.webhook_events add column if not exists claimed_at timestamptz;

create or replace function public.stamp_webhook_claim()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'in_progress' and old.status is distinct from 'in_progress' then
    new.claimed_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists webhook_events_stamp_claim on public.webhook_events;
create trigger webhook_events_stamp_claim before update on public.webhook_events
  for each row execute function public.stamp_webhook_claim();

-- 3. Return abandoned claims to pending. Attempts are not incremented: the
--    delivery may or may not have happened, so a recovered event can be
--    delivered again (at-least-once). Receivers should dedupe on the event.
create or replace function public.reclaim_stale_webhook_events(p_stale_after_seconds integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.webhook_events
     set status = 'pending'
   where status = 'in_progress'
     and (claimed_at is null or claimed_at < now() - make_interval(secs => p_stale_after_seconds));
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.reclaim_stale_webhook_events(integer) from public, anon, authenticated;
grant execute on function public.reclaim_stale_webhook_events(integer) to service_role;

commit;
