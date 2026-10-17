-- Base schema and RPCs for phases 2-5 (ingest, delivery worker, DLQ + circuit
-- breaker, dashboard reads).
--
-- RECONSTRUCTED. The original migrations were applied to the Supabase project
-- out-of-band and were never committed. This file was rebuilt from what the
-- application code calls (src/*.ts), the behaviour the test double models
-- (tests/fakeSupabase.ts, which records what was observed live), and the
-- objects that migrations 008 and 009 assume already exist. Where the live
-- definition could not be inferred, the choice is marked "assumption" below.
--
-- Use migrations/inspect_live_schema.sql to dump the live definitions and
-- compare them with this file before trusting it as the record of production.
--
-- Transactional and repeatable: every statement is "if not exists" or "create
-- or replace", so it can be applied to a fresh database or re-run over the live
-- one without altering existing rows. Run as the database owner, never via anon.
-- Order: 000 -> 008 -> 009.
begin;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.webhook_events (
  id              uuid primary key,
  source          text not null,
  idempotency_key text,
  headers         jsonb not null default '{}'::jsonb,
  payload         jsonb not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'in_progress', 'delivered', 'failed', 'dead_lettered')),
  attempts        integer not null default 0 check (attempts >= 0),
  destination_url text,
  next_attempt_at timestamptz,
  received_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Ingest relies on this surfacing as unique_violation (23505) to answer 200
-- "duplicate". NULL keys never collide, so requests without a key are distinct.
create unique index if not exists webhook_events_source_idempotency_key_idx
  on public.webhook_events (source, idempotency_key);

-- The claim query: pending rows whose retry time has arrived.
create index if not exists webhook_events_claimable_idx
  on public.webhook_events (status, next_attempt_at);

-- Dashboard lists newest first.
create index if not exists webhook_events_received_at_idx
  on public.webhook_events (received_at desc);

create table if not exists public.circuit_breakers (
  destination_url      text primary key,
  state                text not null default 'closed' check (state in ('closed', 'open')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  opened_at            timestamptz,
  next_probe_at        timestamptz,
  updated_at           timestamptz not null default now()
);

alter table public.webhook_events enable row level security;
alter table public.circuit_breakers enable row level security;

-- updated_at bookkeeping. 009 adds a second BEFORE UPDATE trigger on
-- webhook_events (claimed_at); Postgres fires same-event triggers in name order
-- and both only set NEW columns, so they do not interfere.
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists webhook_events_set_updated_at on public.webhook_events;
create trigger webhook_events_set_updated_at before update on public.webhook_events
  for each row execute function public.set_updated_at();

drop trigger if exists circuit_breakers_set_updated_at on public.circuit_breakers;
create trigger circuit_breakers_set_updated_at before update on public.circuit_breakers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Delivery worker RPCs (src/deliveryWorker.ts)
-- ---------------------------------------------------------------------------

-- Returns due pending rows and flips them to in_progress in one statement, so two
-- workers polling at once never claim the same row (SKIP LOCKED). The column list
-- is exactly ClaimedWebhookEvent; raw_body is read separately by the worker.
-- Assumption: batch size 50 (the live value was not recorded).
create or replace function public.claim_pending_webhook_events()
returns table (id uuid, source text, attempts integer, payload jsonb, destination_url text)
language sql security definer set search_path = '' as $$
  with due as (
    select e.id
      from public.webhook_events e
     where e.status = 'pending'
       and (e.next_attempt_at is null or e.next_attempt_at <= now())
     order by e.next_attempt_at nulls first, e.received_at
     limit 50
     for update skip locked
  )
  update public.webhook_events e
     set status = 'in_progress'
    from due
   where e.id = due.id
  returning e.id, e.source, e.attempts, e.payload, e.destination_url;
$$;

create or replace function public.mark_webhook_event_delivered(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.webhook_events
     set status = 'delivered', next_attempt_at = null
   where id = p_id;
$$;

-- Spends one attempt. Dead-letters once attempts reach p_max_attempts, otherwise
-- returns the row to pending with the caller's backoff time.
create or replace function public.mark_webhook_event_retry(
  p_id uuid, p_next_attempt_at timestamptz, p_max_attempts integer)
returns void language sql security definer set search_path = '' as $$
  update public.webhook_events
     set attempts = attempts + 1,
         status = case when attempts + 1 >= p_max_attempts then 'dead_lettered' else 'pending' end,
         next_attempt_at = case when attempts + 1 >= p_max_attempts then null else p_next_attempt_at end
   where id = p_id;
$$;

-- Returns a claimed row to pending WITHOUT spending an attempt. Used when a
-- breaker is open (wait until its probe time) and to release a row after an
-- unexpected error.
create or replace function public.mark_webhook_event_skipped(p_id uuid, p_next_attempt_at timestamptz)
returns void language sql security definer set search_path = '' as $$
  update public.webhook_events
     set status = 'pending', next_attempt_at = p_next_attempt_at
   where id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Circuit breaker RPCs
-- ---------------------------------------------------------------------------

-- Always exactly one row: a destination with no breaker row reads as closed.
create or replace function public.get_circuit_breaker_state(p_destination_url text)
returns table (state text, next_probe_at timestamptz)
language sql security definer set search_path = '' as $$
  select coalesce(b.state, 'closed'), b.next_probe_at
    from (select 1) as one
    left join public.circuit_breakers b on b.destination_url = p_destination_url;
$$;

create or replace function public.record_delivery_success(p_destination_url text)
returns void language sql security definer set search_path = '' as $$
  insert into public.circuit_breakers (destination_url, state, consecutive_failures, opened_at, next_probe_at)
  values (p_destination_url, 'closed', 0, null, null)
  on conflict (destination_url) do update
    set state = 'closed', consecutive_failures = 0, opened_at = null, next_probe_at = null;
$$;

-- Five consecutive failures open the breaker for 60 seconds. A failed probe
-- (already open, failures already >= 5) pushes next_probe_at out another 60s.
create or replace function public.record_delivery_failure(p_destination_url text)
returns void language sql security definer set search_path = '' as $$
  insert into public.circuit_breakers (destination_url, state, consecutive_failures, opened_at, next_probe_at)
  values (p_destination_url, 'closed', 1, null, null)
  on conflict (destination_url) do update
    set consecutive_failures = public.circuit_breakers.consecutive_failures + 1,
        state = case when public.circuit_breakers.consecutive_failures + 1 >= 5 then 'open'
                     else public.circuit_breakers.state end,
        opened_at = case when public.circuit_breakers.consecutive_failures + 1 >= 5
                         then coalesce(public.circuit_breakers.opened_at, now()) end,
        next_probe_at = case when public.circuit_breakers.consecutive_failures + 1 >= 5
                             then now() + interval '60 seconds' end;
$$;

-- ---------------------------------------------------------------------------
-- DLQ RPCs (src/dlq.ts)
-- ---------------------------------------------------------------------------

create or replace function public.list_dead_lettered_events(p_limit integer default 50)
returns setof public.webhook_events
language sql security definer set search_path = '' as $$
  select * from public.webhook_events
   where status = 'dead_lettered'
   order by updated_at desc
   limit greatest(p_limit, 0);
$$;

-- Returns void whether or not a row matched (observed live). Callers check the
-- dead-letter list first.
create or replace function public.replay_webhook_event(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.webhook_events
     set status = 'pending', attempts = 0, next_attempt_at = null
   where id = p_id and status = 'dead_lettered';
$$;

-- ---------------------------------------------------------------------------
-- Dashboard reads (src/dashboard.ts; originally "add_dashboard_read_functions")
-- ---------------------------------------------------------------------------

-- p_status null means every status; an unknown status matches nothing (no error).
create or replace function public.list_webhook_events(p_status text default null, p_limit integer default 100)
returns setof public.webhook_events
language sql security definer set search_path = '' as $$
  select * from public.webhook_events
   where p_status is null or status = p_status
   order by received_at desc
   limit greatest(p_limit, 0);
$$;

create or replace function public.list_circuit_breakers()
returns setof public.circuit_breakers
language sql security definer set search_path = '' as $$
  select * from public.circuit_breakers order by destination_url;
$$;

-- Privileges are not granted here. Migration 008 revokes anon/authenticated
-- access to every object above and grants it to service_role; apply it next.

commit;
