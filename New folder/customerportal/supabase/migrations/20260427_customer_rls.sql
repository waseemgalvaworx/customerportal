-- =============================================================================
-- Customer-role Row Level Security for the Galvabond customer portal
-- =============================================================================
-- Run this in the Supabase SQL editor for the shared backend project
-- (obtmrrbajlrdnmnfhcas).
--
-- WHAT THIS DOES
-- --------------
-- Enables RLS and adds SELECT policies so that a logged-in *customer* user can
-- only read:
--   • their own row in `customers`           (matched by customers."userId")
--   • jobs / QC / stage tracking rows whose `customerName` equals that
--     customer's `name`.
--
-- PREREQUISITES — APPLY IN THIS ORDER
-- -----------------------------------
--   1. 20260427_customers_user_id.sql
--        Adds the `customers."userId"` column + FK to auth.users.id.
--   2. supabase/functions/customer-auth-backfill (see
--        20260427_customer_auth_backfill_README.md)
--        Creates a real Supabase Auth user for every existing customer
--        and writes the uid back into `customers."userId"`.
--   3. THIS file — turns RLS on and adds the SELECT policies below.
--
-- The web portal has already been migrated to real Supabase Auth
-- (`supabase.auth.signInWithPassword(...)` with `persistSession: true`),
-- so once a customer has a row in auth.users with `userId` linked,
-- `auth.uid()` will be populated on every client request and the
-- policies below will scope reads correctly.
--
-- Defense in depth: the client also applies an explicit
-- `.eq('customerName', customer.name)` filter — keep it; it makes intent
-- obvious and protects against any future regression where a service
-- role accidentally proxies a customer query.
-- =============================================================================



-- -----------------------------------------------------------------------------
-- 0. Helper: resolve the current customer's name from auth.uid()
-- -----------------------------------------------------------------------------
-- A SECURITY DEFINER function lets policies on `jobs` / `quality_control` /
-- `item_stage_tracking` look up the caller's customer name without needing
-- their own SELECT permission on `customers` (avoids recursive policy checks
-- and keeps things fast — Postgres will inline + cache the call per query).

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
-- 1. customers — a user can read only their own row
-- -----------------------------------------------------------------------------
alter table public.customers enable row level security;

drop policy if exists "customers_select_own" on public.customers;
create policy "customers_select_own"
  on public.customers
  for select
  to authenticated
  using ( "userId" = auth.uid() );

-- (No INSERT / UPDATE / DELETE policies are added here — those operations
-- continue to require the service role, which bypasses RLS.)


-- -----------------------------------------------------------------------------
-- 2. jobs — a customer user can read only jobs whose customerName matches
-- -----------------------------------------------------------------------------
alter table public.jobs enable row level security;

drop policy if exists "jobs_select_own_customer" on public.jobs;
create policy "jobs_select_own_customer"
  on public.jobs
  for select
  to authenticated
  using ( "customerName" = public.current_customer_name() );


-- -----------------------------------------------------------------------------
-- 3. quality_control — same scoping rule
-- -----------------------------------------------------------------------------
alter table public.quality_control enable row level security;

drop policy if exists "qc_select_own_customer" on public.quality_control;
create policy "qc_select_own_customer"
  on public.quality_control
  for select
  to authenticated
  using ( "customerName" = public.current_customer_name() );


-- -----------------------------------------------------------------------------
-- 4. item_stage_tracking — same scoping rule
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
-- Run these *while logged in as a customer user* (i.e. from the browser
-- console after auth, or via `supabase.auth.signInWithPassword(...)` in a
-- Node REPL with the anon key — NOT with the service role key, which bypasses
-- RLS).
--
-- 1) Confirm you can see exactly one customers row — your own:
--      select id, name, "userId" from public.customers;
--    Expected: 1 row, where "userId" = auth.uid().
--
-- 2) Confirm jobs are correctly scoped:
--      select count(*) as my_jobs
--      from public.jobs;
--    Expected: matches the count visible in the portal's Active + History tabs.
--
-- 3) Confirm you CANNOT see another customer's jobs. Pick any customerName
--    that is NOT yours (ask an admin for one, or use the staff app), then run:
--      select count(*) as leaked
--      from public.jobs
--      where "customerName" = 'Some Other Customer Pty Ltd';
--    Expected: 0. If this returns > 0, RLS is misconfigured — STOP and review
--    the policies above.
--
-- 4) Sanity-check the helper resolves correctly:
--      select public.current_customer_name() as me;
--    Expected: your own customer name (not null).
-- =============================================================================


-- =============================================================================
-- ROLLBACK (if you need to undo this migration)
-- =============================================================================
-- alter table public.customers           disable row level security;
-- alter table public.jobs                disable row level security;
-- alter table public.quality_control     disable row level security;
-- alter table public.item_stage_tracking disable row level security;
-- drop policy if exists "customers_select_own"      on public.customers;
-- drop policy if exists "jobs_select_own_customer"  on public.jobs;
-- drop policy if exists "qc_select_own_customer"    on public.quality_control;
-- drop policy if exists "ist_select_own_customer"   on public.item_stage_tracking;
-- drop function if exists public.current_customer_name();


-- =============================================================================
-- VARIANT — "Service-role only" (use if you keep custom auth, Option B above)
-- =============================================================================
-- If you are NOT migrating to Supabase Auth, you can still benefit from RLS by
-- making the tables completely unreadable to the anon / authenticated roles
-- and forcing every customer-portal read through an edge function that uses
-- the service role key:
--
--   alter table public.jobs                enable row level security;
--   alter table public.quality_control     enable row level security;
--   alter table public.item_stage_tracking enable row level security;
--   -- ...and DO NOT add any SELECT policies. With RLS on and no policies,
--   --    only the service role (which bypasses RLS) can read.
--
-- Then create an edge function `customer-jobs` that:
--   1. Validates a session token issued by `secure-login`.
--   2. Looks up the customer row by user_id with the service role key.
--   3. Runs `select * from jobs where "customerName" = <that name>` and
--      returns the result.
--
-- The frontend would call `supabase.functions.invoke('customer-jobs', ...)`
-- instead of `supabase.from('jobs').select(...)`.
-- =============================================================================
