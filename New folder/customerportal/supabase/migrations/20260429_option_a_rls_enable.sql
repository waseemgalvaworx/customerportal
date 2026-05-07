-- =============================================================================
-- OPTION A — Enable RLS on the customer portal tables (PRODUCTION SECURITY FIX)
-- =============================================================================
-- Project: obtmrrbajlrdnmnfhcas (the shared Galvabond backend)
-- Run after: 20260429_DEPLOY_RLS_README.md  Step B (auth backfill) succeeds.
--
-- WHAT THIS DOES
-- --------------
-- Closes the critical security finding flagged by Supabase: today the
-- `customers`, `jobs`, `quality_control`, and `item_stage_tracking` tables
-- have RLS DISABLED, meaning anyone with the publishable anon key can read
-- the entire dataset directly via PostgREST.
--
-- This migration:
--   1. (Re)creates the `public.current_customer_name()` SECURITY DEFINER
--      helper that resolves auth.uid() → customers.name.
--   2. Enables RLS on customers / jobs / quality_control / item_stage_tracking.
--   3. Adds SELECT policies that scope every authenticated client read to
--      the customer linked to `customers."userId" = auth.uid()`.
--
-- WHY DATA WILL STILL SHOW IN THE PORTAL
-- --------------------------------------
-- After step B of the deployment guide, every customer that should have
-- portal access has a real auth.users row, AND `customers."userId"` points
-- at that auth.users.id. The frontend's updated PasswordAuthContext now
-- calls `supabase.auth.signInWithPassword(...)` first, which means
-- `auth.uid()` is populated on every PostgREST request and the policies
-- below resolve to that customer's rows.
--
-- For accounts that haven't been migrated yet (no auth.users row, or
-- mismatched password), the frontend transparently falls back to the
-- legacy `secure-login` edge function and reads data via the
-- `customer-jobs` edge function — which uses the SERVICE ROLE key and
-- bypasses RLS entirely, so those users keep working too.
--
-- DEPLOY ORDER
-- ------------
--   1. 20260427_customers_user_id.sql           (column + FK + indexes)
--   2. customer-auth-backfill edge function     (creates auth.users rows)
--   3. THIS FILE                                (turn RLS on)
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
end $$;

-- Optional but recommended: warn (not fail) if there are still customers
-- without a userId. Those accounts will be invisible via direct queries
-- once RLS is on, but they CAN still be served by the customer-jobs edge
-- function (service role bypasses RLS), so this is just informational.
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
-- 1. Helper function: current_customer_name()
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER lets the per-row policies on jobs / quality_control /
-- item_stage_tracking look up the caller's customer name without recursing
-- through the customers table's own RLS.
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
-- 3. jobs — only rows whose customerName matches the caller's customer
-- -----------------------------------------------------------------------------
alter table public.jobs enable row level security;

drop policy if exists "jobs_select_own_customer" on public.jobs;
create policy "jobs_select_own_customer"
  on public.jobs
  for select
  to authenticated
  using ( "customerName" = public.current_customer_name() );


-- -----------------------------------------------------------------------------
-- 4. quality_control — same scoping rule
-- -----------------------------------------------------------------------------
alter table public.quality_control enable row level security;

drop policy if exists "qc_select_own_customer" on public.quality_control;
create policy "qc_select_own_customer"
  on public.quality_control
  for select
  to authenticated
  using ( "customerName" = public.current_customer_name() );


-- -----------------------------------------------------------------------------
-- 5. item_stage_tracking — same scoping rule
-- -----------------------------------------------------------------------------
alter table public.item_stage_tracking enable row level security;

drop policy if exists "ist_select_own_customer" on public.item_stage_tracking;
create policy "ist_select_own_customer"
  on public.item_stage_tracking
  for select
  to authenticated
  using ( "customerName" = public.current_customer_name() );


-- =============================================================================
-- VERIFICATION
-- =============================================================================
-- Run these from the SQL editor (which uses the service role and BYPASSES
-- RLS, so they always succeed) to sanity-check the configuration:
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
--      const { data: jobs } = await supabase.from('jobs').select('id, "customerName"').limit(5);
--      console.log(jobs);   // every row should have "customerName" = your customer
--
-- 4) Cross-tenant leak test (replace with a known OTHER customer name):
--      const { data: leak } = await supabase
--        .from('jobs')
--        .select('id')
--        .eq('customerName', 'Some Other Customer Pty Ltd');
--      console.log(leak);   // MUST be []  — if it has rows, RLS is misconfigured
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
-- drop function if exists public.current_customer_name();
-- =============================================================================
