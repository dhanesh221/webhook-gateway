-- Behavioural self-test for migrations 000 -> 008 -> 009, run by
-- scripts/test-migrations.sh against a throwaway Postgres. It exercises each RPC
-- the way the application does and raises if any outcome differs from what
-- tests/fakeSupabase.ts models. Not for the live database: it inserts rows.
begin;

create extension if not exists pgcrypto;

do $$
declare
  v_id uuid := gen_random_uuid();
  v_dup_id uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_url text := 'https://selftest.invalid/hook';
  r record;
  n integer;
  v_state text;
  v_probe timestamptz;
begin
  -- ---- ingest: insert + idempotency unique index --------------------------
  insert into public.webhook_events (id, source, idempotency_key, headers, payload, raw_body, status, destination_url)
  values (v_id, 'selftest', 'key-1', '{}'::jsonb, '{"n":1}'::jsonb, '{"n":1}', 'pending', v_url);

  begin
    insert into public.webhook_events (id, source, idempotency_key, headers, payload, raw_body, status, destination_url)
    values (v_dup_id, 'selftest', 'key-1', '{}'::jsonb, '{"n":1}'::jsonb, '{"n":1}', 'pending', v_url);
    raise exception 'duplicate idempotency key was accepted';
  exception when unique_violation then
    null; -- 23505, what src/app.ts turns into 200 duplicate
  end;

  -- Same key under a different source is a different event.
  insert into public.webhook_events (id, source, idempotency_key, headers, payload, raw_body, status, destination_url)
  values (v_other, 'other-source', 'key-1', '{}'::jsonb, '{"n":2}'::jsonb, '{"n":2}', 'pending', v_url);

  -- Null keys never collide.
  insert into public.webhook_events (id, source, idempotency_key, headers, payload, raw_body, status, destination_url)
  values (gen_random_uuid(), 'selftest', null, '{}'::jsonb, '{"n":3}'::jsonb, '{"n":3}', 'pending', v_url);
  insert into public.webhook_events (id, source, idempotency_key, headers, payload, raw_body, status, destination_url)
  values (gen_random_uuid(), 'selftest', null, '{}'::jsonb, '{"n":4}'::jsonb, '{"n":4}', 'pending', v_url);

  -- ---- claim: returns ClaimedWebhookEvent columns, flips to in_progress -----
  select count(*) into n from public.claim_pending_webhook_events();
  if n <> 4 then raise exception 'expected 4 claimed, got %', n; end if;
  select status, claimed_at is not null as stamped into r from public.webhook_events where id = v_id;
  if r.status <> 'in_progress' or not r.stamped then
    raise exception 'claim did not set in_progress/claimed_at: %', r;
  end if;
  -- Nothing left to claim.
  select count(*) into n from public.claim_pending_webhook_events();
  if n <> 0 then raise exception 'second claim returned % rows', n; end if;

  -- ---- skipped: back to pending without spending an attempt ---------------
  perform public.mark_webhook_event_skipped(v_id, now() + interval '1 hour');
  select status, attempts, next_attempt_at into r from public.webhook_events where id = v_id;
  if r.status <> 'pending' or r.attempts <> 0 or r.next_attempt_at is null then
    raise exception 'skipped wrong: %', r;
  end if;
  -- Not due yet, so not claimable.
  select count(*) into n from public.claim_pending_webhook_events() c where c.id = v_id;
  if n <> 0 then raise exception 'claimed an event whose next_attempt_at is in the future'; end if;
  update public.webhook_events set next_attempt_at = now() - interval '1 second' where id = v_id;
  select count(*) into n from public.claim_pending_webhook_events() c where c.id = v_id;
  if n <> 1 then raise exception 'due event was not claimed'; end if;

  -- ---- retry x5 -> dead_lettered ------------------------------------------
  for i in 1..4 loop
    perform public.mark_webhook_event_retry(v_id, now(), 5);
    select status, attempts into r from public.webhook_events where id = v_id;
    if r.status <> 'pending' or r.attempts <> i then raise exception 'retry % wrong: %', i, r; end if;
  end loop;
  perform public.mark_webhook_event_retry(v_id, now(), 5);
  select status, attempts into r from public.webhook_events where id = v_id;
  if r.status <> 'dead_lettered' or r.attempts <> 5 then raise exception 'dead-letter wrong: %', r; end if;

  -- ---- DLQ list / replay ----------------------------------------------------
  select count(*) into n from public.list_dead_lettered_events(50) d where d.id = v_id;
  if n <> 1 then raise exception 'dead-lettered event not listed'; end if;
  select count(*) into n from public.list_webhook_events('dead_lettered', 100) d where d.id = v_id;
  if n <> 1 then raise exception 'dashboard dead_lettered filter missed the event'; end if;
  select count(*) into n from public.list_webhook_events('nonsense', 100);
  if n <> 0 then raise exception 'unknown status should match nothing'; end if;
  select count(*) into n from public.list_webhook_events(null, 100);
  if n <> 4 then raise exception 'null status should list all 4 events, got %', n; end if;

  perform public.replay_webhook_event(v_id);
  select status, attempts, next_attempt_at into r from public.webhook_events where id = v_id;
  if r.status <> 'pending' or r.attempts <> 0 or r.next_attempt_at is not null then
    raise exception 'replay wrong: %', r;
  end if;
  -- Replaying a non-dead-lettered id is a silent no-op (observed live).
  perform public.replay_webhook_event(v_id);
  perform public.replay_webhook_event(gen_random_uuid());

  -- ---- delivered ------------------------------------------------------------
  perform public.claim_pending_webhook_events();
  perform public.mark_webhook_event_delivered(v_id);
  select status into r from public.webhook_events where id = v_id;
  if r.status <> 'delivered' then raise exception 'delivered wrong: %', r; end if;

  -- ---- circuit breaker ------------------------------------------------------
  select state, next_probe_at into v_state, v_probe from public.get_circuit_breaker_state(v_url);
  if v_state <> 'closed' or v_probe is not null then raise exception 'unknown breaker should read closed'; end if;
  for i in 1..4 loop
    perform public.record_delivery_failure(v_url);
  end loop;
  select state into v_state from public.get_circuit_breaker_state(v_url);
  if v_state <> 'closed' then raise exception 'breaker opened before 5 failures'; end if;
  perform public.record_delivery_failure(v_url);
  select state, next_probe_at into v_state, v_probe from public.get_circuit_breaker_state(v_url);
  if v_state <> 'open' or v_probe is null or v_probe <= now() or v_probe > now() + interval '61 seconds' then
    raise exception 'breaker did not open for ~60s: % %', v_state, v_probe;
  end if;
  select consecutive_failures, opened_at into r from public.circuit_breakers where destination_url = v_url;
  if r.consecutive_failures <> 5 or r.opened_at is null then raise exception 'breaker row wrong: %', r; end if;
  -- A failed probe keeps it open and pushes the probe time out.
  perform public.record_delivery_failure(v_url);
  select state, consecutive_failures into r from public.circuit_breakers where destination_url = v_url;
  if r.state <> 'open' or r.consecutive_failures <> 6 then raise exception 'failed probe wrong: %', r; end if;
  -- Success closes and resets.
  perform public.record_delivery_success(v_url);
  select state, consecutive_failures, opened_at, next_probe_at into r from public.circuit_breakers where destination_url = v_url;
  if r.state <> 'closed' or r.consecutive_failures <> 0 or r.opened_at is not null or r.next_probe_at is not null then
    raise exception 'success did not reset breaker: %', r;
  end if;
  select count(*) into n from public.list_circuit_breakers() b where b.destination_url = v_url;
  if n <> 1 then raise exception 'breaker not listed'; end if;

  -- ---- 009: stale claim reclaim ----------------------------------------------
  update public.webhook_events set status = 'pending', next_attempt_at = null where id = v_other;
  perform public.claim_pending_webhook_events();
  select public.reclaim_stale_webhook_events(600) into n;
  if n <> 0 then raise exception 'fresh claim was reclaimed'; end if;
  update public.webhook_events set claimed_at = now() - interval '11 minutes' where id = v_other;
  select public.reclaim_stale_webhook_events(600) into n;
  if n <> 1 then raise exception 'stale claim not reclaimed (got %)', n; end if;
  select status, attempts into r from public.webhook_events where id = v_other;
  if r.status <> 'pending' or r.attempts <> 0 then raise exception 'reclaim wrong: %', r; end if;

  -- ---- 008: sources and sessions --------------------------------------------
  perform public.upsert_webhook_source('payments', 'https://example.invalid/p', 'WG_SOURCE_PAYMENTS_SECRET');
  select count(*) into n from public.get_webhook_source('payments');
  if n <> 1 then raise exception 'source not found'; end if;
  -- 011: scheme defaults to gateway, can be set, unknown values rejected.
  select signature_scheme into r from public.get_webhook_source('payments');
  if r.signature_scheme <> 'gateway' then raise exception 'default scheme wrong: %', r; end if;
  perform public.upsert_webhook_source('gh', 'https://example.invalid/gh', 'WG_SOURCE_GH_SECRET', 'github');
  select signature_scheme into r from public.get_webhook_source('gh');
  if r.signature_scheme <> 'github' then raise exception 'github scheme not stored: %', r; end if;
  begin
    perform public.upsert_webhook_source('bad', 'https://example.invalid/b', 'WG_SOURCE_BAD_SECRET', 'paypal');
    raise exception 'unknown scheme accepted';
  exception when check_violation then null; end;
  -- 010: a due probe is claimable exactly once.
  perform public.record_delivery_failure('https://probe.invalid/');
  update public.circuit_breakers set state = 'open', next_probe_at = now() - interval '1 second' where destination_url = 'https://probe.invalid/';
  if not public.claim_circuit_probe('https://probe.invalid/', 30) then raise exception 'due probe not claimable'; end if;
  if public.claim_circuit_probe('https://probe.invalid/', 30) then raise exception 'probe claimed twice'; end if;
  if not public.disable_webhook_source('payments') then raise exception 'disable returned false'; end if;
  if public.disable_webhook_source('nope') then raise exception 'disable of unknown returned true'; end if;
  select enabled into r from public.get_webhook_source('payments');
  if r.enabled then raise exception 'source still enabled'; end if;

  perform public.create_dashboard_session(v_dup_id, now() + interval '12 hours');
  if not public.is_dashboard_session_active(v_dup_id) then raise exception 'session not active'; end if;
  perform public.revoke_dashboard_session(v_dup_id);
  if public.is_dashboard_session_active(v_dup_id) then raise exception 'session still active after revoke'; end if;
  begin
    perform public.create_dashboard_session(gen_random_uuid(), now() + interval '2 days');
    raise exception 'over-long session accepted';
  exception when others then
    if sqlerrm not like '%Invalid session expiry%' then raise; end if;
  end;

  -- ---- updated_at trigger ---------------------------------------------------
  -- now() is fixed for the whole transaction, so instead write an obviously
  -- stale value and check the trigger overwrote it.
  update public.webhook_events set updated_at = '2000-01-01' where id = v_id;
  if (select updated_at from public.webhook_events where id = v_id) <> now() then
    raise exception 'updated_at trigger did not fire';
  end if;
  update public.circuit_breakers set updated_at = '2000-01-01' where destination_url = v_url;
  if (select updated_at from public.circuit_breakers where destination_url = v_url) <> now() then
    raise exception 'circuit_breakers updated_at trigger did not fire';
  end if;

  raise notice 'selftest: behaviour OK';
end;
$$;

-- ---- 008: privileges. anon/authenticated must be locked out entirely. --------
do $$
declare
  f record;
  bad text := '';
begin
  for f in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args, r.rolname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated')) as r(rolname)
     where n.nspname = 'public'
       and p.proname like any (array['%webhook%', '%circuit_breaker%', '%delivery_%', '%dashboard_session%'])
       and p.prorettype <> 'trigger'::regtype  -- trigger functions cannot be called directly
       and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
  loop
    bad := bad || format(' %s(%s)->%s', f.proname, f.args, f.rolname);
  end loop;
  for f in
    select c.relname, r.rolname
      from pg_class c
      cross join (values ('anon'), ('authenticated')) as r(rolname)
     where c.oid in ('public.webhook_events'::regclass, 'public.circuit_breakers'::regclass,
                     'public.webhook_sources'::regclass, 'public.dashboard_sessions'::regclass)
       and has_table_privilege(r.rolname, c.oid, 'SELECT')
  loop
    bad := bad || format(' table %s->%s', f.relname, f.rolname);
  end loop;
  if bad <> '' then raise exception 'privilege gaps:%', bad; end if;

  for f in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like any (array['%webhook%', '%circuit_breaker%', '%delivery_%', '%dashboard_session%'])
       and p.prorettype <> 'trigger'::regtype
       and not has_function_privilege('service_role', p.oid, 'EXECUTE')
  loop
    bad := bad || format(' %s(%s)', f.proname, f.args);
  end loop;
  if bad <> '' then raise exception 'service_role cannot execute:%', bad; end if;

  raise notice 'selftest: privileges OK';
end;
$$;

rollback;
