-- =============================================================================
-- customers.userId — link each customer row to a Supabase Auth user
-- =============================================================================
-- Run in the shared backend (obtmrrbajlrdnmnfhcas) BEFORE applying
-- 20260427_customer_rls.sql, and BEFORE running the
-- `customer-auth-backfill` edge function.
--
-- The column is named "userId" (camelCase, quoted) to match the rest of the
-- shared backend's naming convention. RLS policies / the
-- public.current_customer_name() helper reference this exact identifier.
-- =============================================================================

-- 1. Add the column if it doesn't already exist.
alter table public.customers
  add column if not exists "userId" uuid;

-- 2. Make sure it points at an actual auth.users row (and clear it if that
--    user is ever deleted, so the customer row doesn't end up orphaned).
do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'customers'
      and constraint_name = 'customers_userId_fkey'
  ) then
    alter table public.customers
      add constraint "customers_userId_fkey"
      foreign key ("userId")
      references auth.users(id)
      on delete set null;
  end if;
end $$;

-- 3. One auth user → at most one customer row. (A staff member who is also a
--    customer would get a separate auth user.)
create unique index if not exists customers_userId_unique
  on public.customers("userId")
  where "userId" is not null;

-- 4. Fast lookups from the portal: `WHERE "userId" = auth.uid()`.
create index if not exists customers_userId_idx
  on public.customers("userId");

-- =============================================================================
-- VERIFICATION
-- =============================================================================
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name   = 'customers'
--     and column_name  = 'userId';
-- Expected: one row, data_type = uuid, is_nullable = YES.
--
--   select count(*) total,
--          count("userId") linked,
--          count(*) filter (where "userId" is null) unlinked
--   from public.customers;
-- After running the backfill, `unlinked` should be 0 (or only contain
-- intentionally-disabled customers).
-- =============================================================================
