-- =============================================================================
-- RLS DIAGNOSTIC v2 — confirm linkage columns on all four target tables.
-- =============================================================================
-- The earlier dump returned a paginated/truncated result. This version uses
-- pg_catalog (which is unaffected by information_schema visibility quirks)
-- and returns ONLY the columns we care about for RLS scoping, so the result
-- fits comfortably in one response.
--
-- Run this in the Supabase SQL editor and paste the full output back.
-- Read-only: makes ZERO changes.
-- =============================================================================

-- (A) Customer-link / user-link / job-link columns on each target table.
--     Anything matching customer*, user*, or job_id / "jobId".
select
  c.relname                                 as table_name,
  a.attname                                 as column_name,
  format_type(a.atttypid, a.atttypmod)      as data_type
from pg_attribute a
join pg_class     c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname  = 'public'
  and c.relkind  = 'r'
  and c.relname in ('customers','jobs','quality_control','item_stage_tracking')
  and a.attnum   > 0
  and not a.attisdropped
  and (
        a.attname ilike '%customer%'
     or a.attname ilike '%user%'
     or a.attname in ('job_id','jobId','id')
  )
order by c.relname, a.attnum;

-- (B) Current RLS state on the four tables.
select
  c.relname                  as table_name,
  c.relrowsecurity           as rls_enabled,
  c.relforcerowsecurity      as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('customers','jobs','quality_control','item_stage_tracking');

-- (C) Existing policies (so we know what to drop / replace).
select schemaname, tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('customers','jobs','quality_control','item_stage_tracking')
order by tablename, policyname;
