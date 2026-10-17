-- Apply after 012. Transactional and repeatable; run as the database owner.
--
-- Queue depth for the /metrics endpoint: one row per status present. A full
-- count on every scrape is fine at this gateway's scale; if the table grows
-- past a few million rows, replace with an estimate or a maintained counter.
begin;

create or replace function public.count_webhook_events_by_status()
returns table (status text, count bigint)
language sql security definer set search_path = '' as $$
  select status, count(*) from public.webhook_events group by status order by status;
$$;

revoke all on function public.count_webhook_events_by_status() from public, anon, authenticated;
grant execute on function public.count_webhook_events_by_status() to service_role;

commit;
