-- Read-only. Paste into the Supabase SQL editor (as the project owner) to dump
-- the live gateway schema, then diff the output against migrations/000_base_schema.sql,
-- 008 and 009. Nothing here modifies the database.
--
-- Run each section separately if the editor only shows the last result set.

-- 1. Gateway tables: columns, types, nullability, defaults.
select c.table_name, c.ordinal_position, c.column_name, c.data_type,
       c.is_nullable, c.column_default
  from information_schema.columns c
 where c.table_schema = 'public'
   and c.table_name in ('webhook_events', 'circuit_breakers', 'webhook_sources', 'dashboard_sessions')
 order by c.table_name, c.ordinal_position;

-- 2. Constraints (check / primary key / unique) on those tables.
select conrelid::regclass as table_name, conname, contype,
       pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid in ('public.webhook_events'::regclass, 'public.circuit_breakers'::regclass,
                    'public.webhook_sources'::regclass, 'public.dashboard_sessions'::regclass)
 order by 1, 2;

-- 3. Indexes.
select tablename, indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename in ('webhook_events', 'circuit_breakers', 'webhook_sources', 'dashboard_sessions')
 order by 1, 2;

-- 4. Triggers.
select event_object_table as table_name, trigger_name, action_timing, event_manipulation,
       action_statement
  from information_schema.triggers
 where trigger_schema = 'public'
   and event_object_table in ('webhook_events', 'circuit_breakers')
 order by 1, 2;

-- 5. Row level security flags.
select relname as table_name, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
  from pg_class
 where oid in ('public.webhook_events'::regclass, 'public.circuit_breakers'::regclass,
               'public.webhook_sources'::regclass, 'public.dashboard_sessions'::regclass);

-- 6. Full source of every gateway RPC. This is the part the repository lost.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       p.proconfig as config,
       pg_get_functiondef(p.oid) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     'claim_pending_webhook_events', 'mark_webhook_event_delivered', 'mark_webhook_event_retry',
     'mark_webhook_event_skipped', 'get_circuit_breaker_state', 'record_delivery_success',
     'record_delivery_failure', 'list_dead_lettered_events', 'replay_webhook_event',
     'list_webhook_events', 'list_circuit_breakers', 'set_updated_at',
     'get_webhook_source', 'list_webhook_sources', 'upsert_webhook_source', 'disable_webhook_source',
     'create_dashboard_session', 'is_dashboard_session_active', 'revoke_dashboard_session',
     'revoke_all_dashboard_sessions', 'stamp_webhook_claim', 'reclaim_stale_webhook_events')
 order by p.proname;

-- 7. Table privileges by role. After 008, only service_role (and the owner)
--    should appear for the gateway tables.
select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name in ('webhook_events', 'circuit_breakers', 'webhook_sources', 'dashboard_sessions')
 group by grantee, table_name
 order by table_name, grantee;

-- 8. Function EXECUTE privileges by role. After 008, anon/authenticated/PUBLIC
--    must not be able to execute any gateway RPC.
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       r.rolname,
       has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
 where n.nspname = 'public'
   and p.proname like any (array['%webhook%', '%circuit_breaker%', '%delivery_%', '%dashboard_session%'])
   and p.prorettype <> 'trigger'::regtype  -- trigger functions cannot be called directly
 order by p.proname, r.rolname;

-- 9. PUBLIC execute (any role). Postgres grants EXECUTE to PUBLIC by default on
--    new functions; 008 revokes it. Any row here is a gap.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname like any (array['%webhook%', '%circuit_breaker%', '%delivery_%', '%dashboard_session%'])
   and p.prorettype <> 'trigger'::regtype
   and p.proacl is null  -- null ACL means default privileges, i.e. PUBLIC can execute
 order by p.proname;
