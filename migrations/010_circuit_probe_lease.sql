-- Apply after 009. Transactional and repeatable; run as the database owner.
--
-- One probe per open breaker, however many workers are polling.
--
-- Before this, every worker that saw an open breaker whose next_probe_at had
-- passed sent its own probe delivery, so a recovering destination received as
-- many simultaneous requests as there were workers. claim_circuit_probe is the
-- atomic lease: the single UPDATE both checks that a probe is due and pushes
-- next_probe_at forward, so exactly one caller gets true. The others see the new
-- next_probe_at and wait for it. If the winning worker crashes mid-probe the
-- lease simply expires and the next due poll claims it. The worker falls back to
-- the old unleased probe when this function is missing, so deploying the code
-- before the migration is safe.
begin;

create or replace function public.claim_circuit_probe(p_destination_url text, p_lease_seconds integer)
returns boolean language sql security definer set search_path = '' as $$
  with claimed as (
    update public.circuit_breakers
       set next_probe_at = now() + make_interval(secs => greatest(p_lease_seconds, 1))
     where destination_url = p_destination_url
       and state = 'open'
       and (next_probe_at is null or next_probe_at <= now())
    returning 1
  )
  select exists (select 1 from claimed);
$$;

revoke all on function public.claim_circuit_probe(text, integer) from public, anon, authenticated;
grant execute on function public.claim_circuit_probe(text, integer) to service_role;

commit;
