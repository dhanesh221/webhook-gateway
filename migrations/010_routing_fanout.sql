-- WIP: UNVERIFIED. Not applied anywhere. Do not run until the items below are done.
--
-- Not yet verified (follow-ups):
--   * executing this file on a disposable PostgreSQL / Supabase database
--   * rollback behaviour and concurrent uniqueness under load
--   * startup validation tests for WG_ROUTING_RULES
--   * a real-HTTP fan-out test (current tests use an in-memory fake database)
--   * README migration instructions
--
-- Content-based fan-out. Apply after 009. Additive and repeatable; run as the
-- database owner.
--
-- Model: each fan-out copy is its own webhook_events row, so retries, the DLQ
-- and the circuit breaker (all keyed per row / per destination in the existing
-- worker RPCs) stay independent per destination. Copies are linked by
-- fanout_group_id. The first copy keeps the original (source, idempotency_key);
-- sibling copies get NULL keys, so the existing unique index dedupes a
-- redelivered source event across both the legacy and the routed ingest path.
--
-- LIVE SCHEMA ASSUMPTIONS (the Phase 2-5 base schema is not in this repo):
--   * public.webhook_events exists with id uuid (primary key), source text,
--     idempotency_key text, headers json/jsonb, payload json/jsonb,
--     raw_body text (added by 009), status text, destination_url text,
--     attempts integer not null default 0.
--   * status 'pending' is the initial state the worker claims from.
--   * Other columns (received_at, updated_at, next_attempt_at, ...) have
--     defaults or are nullable, so inserting only the columns above is valid.
--   * A unique index on (source, idempotency_key) that is not partial and is
--     valid already exists. This file checks for it and aborts if missing.
--   * jsonb values assign to the headers/payload columns (json or jsonb).
--   * The API role is service_role, as in 009.
begin;

do $$
begin
  if not exists (
    select 1
      from pg_index i
      join pg_attribute a1 on a1.attrelid = i.indrelid and a1.attnum = i.indkey[0]
      join pg_attribute a2 on a2.attrelid = i.indrelid and a2.attnum = i.indkey[1]
     where i.indrelid = 'public.webhook_events'::regclass
       and i.indisunique and i.indisvalid
       and i.indpred is null and i.indexprs is null
       and i.indnkeyatts = 2
       and a1.attname = 'source' and a2.attname = 'idempotency_key'
  ) then
    raise exception 'webhook_events needs a valid, non-partial unique index on (source, idempotency_key)';
  end if;
end;
$$;

alter table public.webhook_events add column if not exists fanout_group_id uuid;
create index if not exists webhook_events_fanout_group_idx
  on public.webhook_events (fanout_group_id) where fanout_group_id is not null;

-- p_children: jsonb array of {"id": uuid, "destination_url": text}, first
-- element first. Returns 'created' or 'duplicate'. All rows are inserted in
-- one transaction; a duplicate (source, idempotency_key) rolls back every child.
create or replace function public.ingest_routed_webhook(
  p_group_id uuid,
  p_source text,
  p_idempotency_key text,
  p_headers jsonb,
  p_payload jsonb,
  p_raw_body text,
  p_children jsonb
) returns text language plpgsql security definer set search_path = '' as $$
declare
  child jsonb;
  idx integer := 0;
begin
  if p_children is null or jsonb_typeof(p_children) <> 'array' or jsonb_array_length(p_children) = 0 then
    raise exception 'p_children must be a non-empty array';
  end if;
  begin
    for child in select * from jsonb_array_elements(p_children) loop
      insert into public.webhook_events
        (id, source, idempotency_key, headers, payload, raw_body, status, destination_url, attempts, fanout_group_id)
      values
        ((child->>'id')::uuid, p_source,
         case when idx = 0 then p_idempotency_key else null end,
         p_headers, p_payload, p_raw_body, 'pending', child->>'destination_url', 0, p_group_id);
      idx := idx + 1;
    end loop;
  exception when unique_violation then
    -- The block is a subtransaction: every child insert above is undone.
    return 'duplicate';
  end;
  return 'created';
end;
$$;
revoke all on function public.ingest_routed_webhook(uuid, text, text, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_routed_webhook(uuid, text, text, jsonb, jsonb, text, jsonb) to service_role;

commit;
