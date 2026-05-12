-- =============================================================================
-- DIAGNOSTICS: why did 20260427_portal_users_userid_backfill.sql link 0 rows?
-- =============================================================================
-- The audit row showed:
--   portal_users_total            : 2
--   portal_users_with_customer_id : null   (column doesn't exist on this DB)
--   customers_linked_before       : 0
--   customers_linked_after        : 0
--   newly_linked                  : 0
--
-- That means PASS 2 (username = customer.name) and PASS 3 (email match) both
-- found no unambiguous matches for either of your two portal users. Run each
-- numbered query below in the Supabase SQL editor to figure out why and pick
-- the right manual fix.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Q1. What columns does public.users actually have on this deployment?
-- -----------------------------------------------------------------------------
-- This tells us which fields we have to match on (username? email? something
-- else like company_name?).
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'users'
order by ordinal_position;


-- -----------------------------------------------------------------------------
-- Q2. Show every portal user — id, username, role, and any email-ish field.
-- -----------------------------------------------------------------------------
-- We're looking at the 2 rows the audit counted. The username is what PASS 2
-- tries to match against customers.name. If these usernames don't look like
-- a company name, that's why no match happened.
select id, username, role
from public.users
where lower(coalesce(role, '')) in ('customer_portal', 'customer')
order by username;

-- If public.users HAS an email column, also run:
--   select id, username, role, email from public.users
--   where lower(coalesce(role, '')) in ('customer_portal', 'customer');


-- -----------------------------------------------------------------------------
-- Q3. What columns does public.customers have?
-- -----------------------------------------------------------------------------
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'customers'
order by ordinal_position;


-- -----------------------------------------------------------------------------
-- Q4. Sample of public.customers — name + any email column + current userId.
-- -----------------------------------------------------------------------------
-- Replace `email` with whatever the actual email column is named (Q3 will
-- tell you; could be email, contactEmail, "contactEmail", etc).
select id, name, "userId"
from public.customers
order by name
limit 50;


-- -----------------------------------------------------------------------------
-- Q5. For EACH portal user, show its closest customer-name candidates.
-- -----------------------------------------------------------------------------
-- This is the most useful diagnostic. It shows you, per portal user, what
-- public.customers rows exist whose name CONTAINS or is CONTAINED IN the
-- username (case- and whitespace-insensitive). If the column lengths are off
-- (e.g. user "GS Steel" vs customer "GS Steel Fabrication LLC") the strict
-- equality match in PASS 2 won't fire, but you'll see the right row here.
with u as (
  select id as user_id, username,
         regexp_replace(lower(trim(username)), '\s+', ' ', 'g') as nuser
  from public.users
  where lower(coalesce(role, '')) in ('customer_portal', 'customer')
),
c as (
  select id as customer_id, name,
         regexp_replace(lower(trim(name)), '\s+', ' ', 'g') as ncust
  from public.customers
  where "userId" is null
)
select
  u.user_id,
  u.username,
  c.customer_id,
  c.name as customer_name,
  case
    when c.ncust = u.nuser                          then 'EXACT'
    when c.ncust like '%' || u.nuser || '%'         then 'CUSTOMER_CONTAINS_USER'
    when u.nuser like '%' || c.ncust || '%'         then 'USER_CONTAINS_CUSTOMER'
    else 'OTHER'
  end as match_type
from u
join c on (
       c.ncust = u.nuser
    or c.ncust like '%' || u.nuser || '%'
    or u.nuser like '%' || c.ncust || '%'
)
order by u.username, match_type;


-- -----------------------------------------------------------------------------
-- Q5b. Same as Q5 but without CTEs (use this if the Supabase SQL editor's
--      auto-applied LIMIT clause breaks the WITH ... query).
-- -----------------------------------------------------------------------------
select
  u.id   as user_id,
  u.username,
  c.id   as customer_id,
  c.name as customer_name,
  case
    when regexp_replace(lower(trim(c.name)), '\s+', ' ', 'g')
       = regexp_replace(lower(trim(u.username)), '\s+', ' ', 'g')
      then 'EXACT'
    when regexp_replace(lower(trim(c.name)), '\s+', ' ', 'g')
         like '%' || regexp_replace(lower(trim(u.username)), '\s+', ' ', 'g') || '%'
      then 'CUSTOMER_CONTAINS_USER'
    when regexp_replace(lower(trim(u.username)), '\s+', ' ', 'g')
         like '%' || regexp_replace(lower(trim(c.name)), '\s+', ' ', 'g') || '%'
      then 'USER_CONTAINS_CUSTOMER'
    else 'OTHER'
  end as match_type
from public.users u
join public.customers c
  on  c."userId" is null
  and (
        regexp_replace(lower(trim(c.name)), '\s+', ' ', 'g')
        = regexp_replace(lower(trim(u.username)), '\s+', ' ', 'g')
     or regexp_replace(lower(trim(c.name)), '\s+', ' ', 'g')
        like '%' || regexp_replace(lower(trim(u.username)), '\s+', ' ', 'g') || '%'
     or regexp_replace(lower(trim(u.username)), '\s+', ' ', 'g')
        like '%' || regexp_replace(lower(trim(c.name)), '\s+', ' ', 'g') || '%'
      )
where lower(coalesce(u.role, '')) in ('customer_portal', 'customer')
order by u.username, match_type;


-- -----------------------------------------------------------------------------
-- Q6. Stragglers: portal users with NO link at all.
-- -----------------------------------------------------------------------------
-- Same query as 5b in the README. After Q5 you'll know which customer row to
-- link each one to.
select u.id as user_id, u.username, u.role
from public.users u
left join public.customers c on c."userId" = u.id
where lower(coalesce(u.role, '')) in ('customer_portal', 'customer')
  and c.id is null
order by u.username;


-- -----------------------------------------------------------------------------
-- Q7. Fuzzy search ALL customers (linked or not) for a specific username.
-- -----------------------------------------------------------------------------
-- Use this when Q5/Q5b returns NO row for a portal user. It looks across every
-- customer regardless of "userId", so you can see whether:
--   (a) the customer exists but is already linked to someone else (wrong link
--       you need to fix), or
--   (b) no matching customer exists at all (you need to INSERT one).
-- Replace 'gs steel' with the username you're hunting for.
select id, name, "userId"
from public.customers
where regexp_replace(lower(trim(name)), '\s+', ' ', 'g')
      like '%' || regexp_replace(lower(trim('gs steel')), '\s+', ' ', 'g') || '%'
   or regexp_replace(lower(trim('gs steel')), '\s+', ' ', 'g')
      like '%' || regexp_replace(lower(trim(name)), '\s+', ' ', 'g') || '%'
order by name;


-- =============================================================================
-- HOW TO FIX MANUALLY (after Q5 tells you the right pairing)
-- =============================================================================
-- For each user/customer pair you confirmed, run:
--
--   update public.customers
--      set "userId" = '<users.id from Q2 / Q6>'
--    where id      = '<customers.id from Q5>'
--      and "userId" is null;
--
-- Verify with:
--
--   select c.id, c.name, c."userId", u.username
--   from public.customers c
--   join public.users u on u.id = c."userId"
--   where lower(coalesce(u.role, '')) in ('customer_portal', 'customer');
--
-- If a user has NO matching customer at all (Q5 returned no row for them),
-- create one:
--
--   insert into public.customers (name, "userId")
--   values ('<display name>', '<users.id>');
--
-- Then have them log in to the portal — `customer-jobs` will resolve the
-- customer by "userId" and return their jobs.
-- =============================================================================
