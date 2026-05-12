-- =============================================================================
-- OPTION A v2 — Enable RLS on the customer portal tables (PRODUCTION SECURITY FIX)
-- =============================================================================
-- Project: obtmrrbajlrdnmnfhcas (the shared Galvabond backend)
-- Supersedes: 20260429_option_a_rls_enable.sql
--
-- WHY v2
-- ------
-- The original migration assumed every table carried a quoted "customerName"
-- text column. The actual schema (verified via 20260430_rls_diagnostic.sql)
-- shows:
--
--   customers:           id (uuid),  "userId" (uuid)        -- portal owner
--   jobs:                "customerId" (uuid)  → customers.id
--   quality_control:     job_id (uuid)        → jobs.id
--   item_stage_tracking: job_id (uuid)        → jobs.id
--
-- So the correct scoping chain is:
--
--   customers           : "userId" = auth.uid()
--   jobs                : EXISTS (customer c WHERE c.id = jobs."customerId"
--                                              AND c."userId" = auth.uid())
--   quality_control     : EXISTS (job  j JOIN customer c ON c.id = j."customerId"
--                                 WHERE j.id = quality_control.job_id
--                                   AND c."userId" = auth.uid())
--   item_stage_tracking : same as quality_control, on item_stage_tracking.job_id
--
-- WHAT THIS DOES
-- --------------
--   1. (Re)creates `public.current_customer_id()` SECURITY DEFINER helper
--      that resolves auth.uid() → customers.id (uuid).
--   2. Enables RLS on customers / jobs / quality_control / item_stage_tracking.
--   3. Adds SELECT policies that scope every authenticated client read to
--      rows owned (directly or transitively) by the caller's customer row.
--
-- DEPLOY ORDER
-- ------------
--   1. 20260427_customers_user_id.sql            (column + FK + indexes)
--   2. customer-auth-backfill edge function      (creates auth.users rows)
--   3. THIS FILE                                 (turn RLS on)
--
-- ROLLBACK is at the bottom if anything goes wrong.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Pre-flight checks (fail loudly if prereqs aren't met).
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'customers'
      and column_name  = 'userId'
  ) then
    raise exception
      'public.customers."userId" is missing — run 20260427_customers_user_id.sql first.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'jobs'
      and column_name  = 'customerId'
  ) then
    raise exception
      'public.jobs."customerId" is missing — schema does not match expected shape.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'quality_control'
      and column_name  = 'job_id'
  ) then
    raise exception
      'public.quality_control.job_id is missing — schema does not match expected shape.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'item_stage_tracking'
      and column_name  = 'job_id'
  ) then
    raise exception
      'public.item_stage_tracking.job_id is missing — schema does not match expected shape.';
  end if;
end $$;

-- Informational: how many customers are still un-backfilled (will be invisible
-- via direct PostgREST queries once RLS is on, but remain reachable through
-- the service-role customer-jobs edge function).
do $$
declare
  unlinked_count int;
begin
  select count(*) into unlinked_count
  from public.customers
  where "userId" is null;
  if unlinked_count > 0 then
    raise notice
      'There are still % customers with NULL "userId". They will only be reachable via the customer-jobs edge function until backfilled.',
      unlinked_count;
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 1. Helper function: current_customer_id()
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER lets per-row policies on jobs / quality_control /
-- item_stage_tracking resolve the caller's customer.id without recursing
-- through the customers table's own RLS.
create or replace function public.current_customer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id
  from public.customers c
  where c."userId" = auth.uid()
  limit 1;
$$;

revoke all on function public.current_customer_id() from public;
grant execute on function public.current_customer_id() to authenticated;

-- Keep the legacy helper around as a thin shim so any older code/policies
-- referring to current_customer_name() keep resolving (returns the same
-- caller's customer name).
create or replace function public.current_customer_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select c."name"
  from public.customers c
  where c."userId" = auth.uid()
  limit 1;
$$;

revoke all on function public.current_customer_name() from public;
grant execute on function public.current_customer_name() to authenticated;


-- -----------------------------------------------------------------------------
-- 2. customers — a user can read only their own row
-- -----------------------------------------------------------------------------
alter table public.customers enable row level security;

drop policy if exists "customers_select_own" on public.customers;
create policy "customers_select_own"
  on public.customers
  for select
  to authenticated
  using ( "userId" = auth.uid() );


-- -----------------------------------------------------------------------------
-- 3. jobs — scoped via jobs."customerId" → customers."userId"
-- -----------------------------------------------------------------------------
alter table public.jobs enable row level security;

drop policy if exists "jobs_select_own_customer" on public.jobs;
create policy "jobs_select_own_customer"
  on public.jobs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.customers c
      where c.id        = public.jobs."customerId"
        and c."userId"  = auth.uid()
    )
  );


-- -----------------------------------------------------------------------------
-- 4. quality_control — scoped via job_id → jobs."customerId" → customers."userId"
-- -----------------------------------------------------------------------------
alter table public.quality_control enable row level security;

drop policy if exists "qc_select_own_customer" on public.quality_control;
create policy "qc_select_own_customer"
  on public.quality_control
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.jobs       j
      join public.customers  c on c.id = j."customerId"
      where j.id       = public.quality_control.job_id
        and c."userId" = auth.uid()
    )
  );


-- -----------------------------------------------------------------------------
-- 5. item_stage_tracking — same chain as quality_control
-- -----------------------------------------------------------------------------
alter table public.item_stage_tracking enable row level security;

drop policy if exists "ist_select_own_customer" on public.item_stage_tracking;
create policy "ist_select_own_customer"
  on public.item_stage_tracking
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.jobs       j
      join public.customers  c on c.id = j."customerId"
      where j.id       = public.item_stage_tracking.job_id
        and c."userId" = auth.uid()
    )
  );


-- =============================================================================
-- VERIFICATION
-- =============================================================================
-- Run these from the SQL editor (service role bypasses RLS, so they always
-- succeed) to sanity-check the configuration:
--
-- 1) RLS is enabled on all four tables:
--      select relname, relrowsecurity
--      from pg_class
--      where relnamespace = 'public'::regnamespace
--        and relname in ('customers','jobs','quality_control','item_stage_tracking');
--    Expected: relrowsecurity = true on every row.
--
-- 2) Policies exist:
--      select schemaname, tablename, policyname
--      from pg_policies
--      where schemaname = 'public'
--        and tablename in ('customers','jobs','quality_control','item_stage_tracking');
--    Expected: 4 policies.
--
-- 3) From the browser DevTools console, AFTER signing into the portal as a
--    backfilled customer (i.e. one with a populated customers."userId"):
--      const { data } = await supabase.from('customers').select('id, name');
--      console.log(data);   // should be exactly ONE row — your own
--
--      const { data: jobs } = await supabase
--        .from('jobs')
--        .select('id, "customerId"')
--        .limit(5);
--      console.log(jobs);   // every row's "customerId" should equal your customer.id
--
-- 4) Cross-tenant leak test (replace with a known OTHER customer.id uuid):
--      const { data: leak } = await supabase
--        .from('jobs')
--        .select('id')
--        .eq('customerId', '00000000-0000-0000-0000-000000000000');
--      console.log(leak);   // MUST be []  — if rows come back, RLS is misconfigured
-- =============================================================================


-- =============================================================================
-- ROLLBACK (paste back into the SQL editor if you need to undo this)
-- =============================================================================
-- alter table public.customers           disable row level security;
-- alter table public.jobs                disable row level security;
-- alter table public.quality_control     disable row level security;
-- alter table public.item_stage_tracking disable row level security;
--
-- drop policy if exists "customers_select_own"      on public.customers;
-- drop policy if exists "jobs_select_own_customer"  on public.jobs;
-- drop policy if exists "qc_select_own_customer"    on public.quality_control;
-- drop policy if exists "ist_select_own_customer"   on public.item_stage_tracking;
-- drop function if exists public.current_customer_id();
-- drop function if exists public.current_customer_name();
-- =============================================================================
