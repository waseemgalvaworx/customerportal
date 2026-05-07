-- =============================================================================
-- Customer-portal users → customers."userId"  ONE-SHOT BACKFILL
-- =============================================================================
-- Run this in the SQL editor of YOUR Supabase project (obtmrrbajlrdnmnfhcas)
-- AFTER `20260427_customers_user_id.sql` has been applied.
--
-- WHY THIS EXISTS
-- ---------------
-- The customer portal's `secure-login` edge function authenticates against a
-- LEGACY `public.users` table (id, username, password, role, customer_id, …).
-- It returns a `user` object whose `id` is `public.users.id` — NOT an
-- `auth.users.id`.
--
-- The new `customer-jobs` edge function (and the RLS policies in
-- `20260427_customer_rls.sql`) need a stable link between that legacy user id
-- and the `public.customers` row, stored in `public.customers."userId"`.
--
-- For some portal accounts that link is missing (e.g. "gs steel" — id
-- 9bace170-565b-4829-9156-5b61256bad95, customer_id NULL). When that's the
-- case the edge function can't resolve a customer and the portal returns 0
-- jobs with a 404 ("No customer profile linked to this user").
--
-- This migration LINKS every legacy `users` row whose role is
-- `customer_portal` (or `customer`) to its matching `customers` row, using
-- progressively looser matchers, and writes the legacy users.id into
-- `customers."userId"`. It NEVER overwrites an existing non-null link.
--
-- IDEMPOTENT: safe to run multiple times.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Preconditions
-- -----------------------------------------------------------------------------
-- Make sure customers."userId" exists. If this errors, run
-- 20260427_customers_user_id.sql first.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'customers'
      and column_name  = 'userId'
  ) then
    raise exception
      'public.customers."userId" is missing. Run 20260427_customers_user_id.sql first.';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'users'
  ) then
    raise exception
      'public.users table not found — secure-login expects a legacy users table on this project.';
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 0.5. Drop the customers."userId" → auth.users(id) foreign key (if present)
-- -----------------------------------------------------------------------------
-- Two parallel auth flows now write into customers."userId":
--   (a) the legacy `secure-login` edge function, whose user.id comes from
--       `public.users.id` (NOT in auth.users), and
--   (b) the real Supabase-Auth path, whose user.id is in auth.users.
-- A FK to auth.users(id) breaks (a). The column already has a unique index
-- and an index for fast lookup — those are kept. We just drop the FK so it
-- can hold either kind of uuid.
do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'customers'
      and constraint_name = 'customers_userId_fkey'
  ) then
    alter table public.customers drop constraint "customers_userId_fkey";
    raise notice 'Dropped FK customers_userId_fkey to allow legacy public.users.id values.';
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 1. Snapshot the "before" state for the audit log at the bottom.
-- -----------------------------------------------------------------------------
create temp table _portal_backfill_before on commit drop as
select
  count(*)                              as portal_users_total,
  count(*) filter (where customer_id is not null) as portal_users_with_customer_id,
  (select count(*) from public.customers c where c."userId" is not null) as customers_linked_before
from public.users u
where lower(coalesce(u.role, '')) in ('customer_portal', 'customer');



-- -----------------------------------------------------------------------------
-- 2. PASS 1 — direct match via users.customer_id
-- -----------------------------------------------------------------------------
-- Most reliable: the portal user already has a customer_id pointing at the
-- right row. We only need to copy users.id into customers."userId".
with src as (
  select u.id as user_id, u.customer_id
  from public.users u
  where lower(coalesce(u.role, '')) in ('customer_portal', 'customer')
    and u.customer_id is not null
)
update public.customers c
set "userId" = src.user_id
from src
where c.id = src.customer_id
  and c."userId" is null;


-- -----------------------------------------------------------------------------
-- 3. PASS 2 — match via case/whitespace-insensitive username = customer.name
-- -----------------------------------------------------------------------------
-- This catches accounts like "gs steel" whose users.customer_id is NULL but
-- whose username matches the customer's display name.
--
-- Matching rules (all applied in one pass via lower(trim(..))):
--   • collapse internal whitespace
--   • lowercase
--   • trim
-- Only links if EXACTLY ONE customer row matches — ambiguous matches are
-- left for manual resolution (reported in the audit query below).
with normalized_users as (
  select
    u.id as user_id,
    regexp_replace(lower(trim(u.username)), '\s+', ' ', 'g') as norm_name
  from public.users u
  where lower(coalesce(u.role, '')) in ('customer_portal', 'customer')
    and u.username is not null
    and u.username <> ''
),
normalized_customers as (
  select
    c.id as customer_id,
    regexp_replace(lower(trim(c.name)), '\s+', ' ', 'g') as norm_name
  from public.customers c
  where c."userId" is null
    and c.name is not null
    and c.name <> ''
),
unique_matches as (
  select nu.user_id, nc.customer_id
  from normalized_users nu
  join normalized_customers nc on nc.norm_name = nu.norm_name
  -- only link if the (user_id, customer name) pair is unambiguous on BOTH sides
  where (
    select count(*) from normalized_customers nc2 where nc2.norm_name = nu.norm_name
  ) = 1
  and (
    select count(*) from normalized_users nu2 where nu2.norm_name = nc.norm_name
  ) = 1
)
update public.customers c
set "userId" = um.user_id
from unique_matches um
where c.id = um.customer_id
  and c."userId" is null;


-- -----------------------------------------------------------------------------
-- 4. PASS 3 — fallback match via email (only when both sides have one)
-- -----------------------------------------------------------------------------
-- Some portal users have a different display name from their company name
-- but share an email with the customer record. Only do this if BOTH the
-- users and customers tables have an `email` column.
do $$
declare
  users_has_email     boolean;
  customers_has_email boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'email'
  ) into users_has_email;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'customers' and column_name = 'email'
  ) into customers_has_email;

  if users_has_email and customers_has_email then
    execute $sql$
      with src as (
        select u.id as user_id, lower(trim(u.email)) as norm_email
        from public.users u
        where lower(coalesce(u.role, '')) in ('customer_portal', 'customer')
          and u.email is not null and u.email <> ''
      ),
      tgt as (
        select c.id as customer_id, lower(trim(c.email)) as norm_email
        from public.customers c
        where c."userId" is null
          and c.email is not null and c.email <> ''
      ),
      uniq as (
        select s.user_id, t.customer_id
        from src s
        join tgt t on t.norm_email = s.norm_email
        where (select count(*) from tgt t2 where t2.norm_email = s.norm_email) = 1
          and (select count(*) from src s2 where s2.norm_email = t.norm_email) = 1
      )
      update public.customers c
      set "userId" = uniq.user_id
      from uniq
      where c.id = uniq.customer_id
        and c."userId" is null;
    $sql$;
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 5. AUDIT REPORT
-- -----------------------------------------------------------------------------
-- After the migration runs, three result sets are printed so you can verify
-- the outcome at a glance.

-- 5a. Headline numbers.
select
  b.portal_users_total,
  b.portal_users_with_customer_id,
  b.customers_linked_before,
  (select count(*) from public.customers c where c."userId" is not null)
    as customers_linked_after,
  (select count(*) from public.customers c where c."userId" is not null)
    - b.customers_linked_before
    as newly_linked
from _portal_backfill_before b;

-- 5b. Portal users that STILL have no link — these need manual attention.
-- Re-run this any time:
--   select u.id, u.username, u.role, u.customer_id
--   from public.users u
--   left join public.customers c on c."userId" = u.id
--   where lower(coalesce(u.role, '')) in ('customer_portal', 'customer')
--     and c.id is null
--   order by u.username;

-- 5c. Customers with multiple potential username matches (ambiguous;
--     PASS 2 deliberately skipped these). Resolve manually:
--   with norm as (
--     select u.id as user_id,
--            regexp_replace(lower(trim(u.username)), '\s+', ' ', 'g') as nname
--     from public.users u
--     where lower(coalesce(u.role, '')) in ('customer_portal', 'customer')
--   )
--   select n.nname, count(*) as candidate_count,
--          array_agg(c.id)   as customer_ids,
--          array_agg(c.name) as customer_names
--   from norm n
--   join public.customers c
--     on regexp_replace(lower(trim(c.name)), '\s+', ' ', 'g') = n.nname
--   group by n.nname
--   having count(*) > 1
--   order by n.nname;


-- =============================================================================
-- MANUAL FIX-UPS for stragglers
-- =============================================================================
-- For each user listed by 5b you have two options:
--
-- (a) The customer row already exists but its name doesn't match the
--     username/email. Link them by id:
--       update public.customers
--          set "userId" = '<users.id>'
--        where id = '<customers.id>' and "userId" is null;
--     Then ALSO update users.customer_id so future logins are pre-linked:
--       update public.users
--          set customer_id = '<customers.id>'
--        where id = '<users.id>' and customer_id is null;
--
-- (b) No customer row exists for this user yet. Create one:
--       insert into public.customers (name, "userId")
--       values ('<display name>', '<users.id>');
--     Then link back:
--       update public.users
--          set customer_id = (select id from public.customers
--                             where "userId" = '<users.id>')
--        where id = '<users.id>';
--
-- KNOWN STRAGGLER FROM THE INITIAL DEPLOY:
--   • username: "gs steel"
--     id:       9bace170-565b-4829-9156-5b61256bad95
--     If a "GS Steel" customer row already exists, PASS 2 will have linked
--     it automatically. If not, follow option (b) above.
-- =============================================================================
