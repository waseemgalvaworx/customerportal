# Production RLS Deployment — Copy-Paste Walkthrough

> **Heads-up about who runs what:** the Famous AI environment cannot
> directly modify your Galvabond production Supabase project
> (`obtmrrbajlrdnmnfhcas`). All commands below must be run by **you**,
> from the Supabase dashboard or your laptop. Each step is short,
> idempotent, and reversible.
>
> Total wall-clock time: ~30 minutes. You can pause between any two
> steps without breaking the portal.

---

## What you'll need open in tabs

1. **Supabase Dashboard → `obtmrrbajlrdnmnfhcas` project → SQL Editor**
   https://supabase.com/dashboard/project/obtmrrbajlrdnmnfhcas/sql/new
2. **Supabase Dashboard → Edge Functions**
   https://supabase.com/dashboard/project/obtmrrbajlrdnmnfhcas/functions
3. **A terminal** on your laptop with the Supabase CLI installed
   (`brew install supabase/tap/supabase` if you don't have it).
4. **Your service role key** — Dashboard → Project Settings → API →
   `service_role` (the one labelled *secret*, NOT the publishable key).
   Treat it like a root password; never paste it into git or chat.

---

## STEP A — Add `customers."userId"` column (~2 min)

**Where:** SQL Editor (tab #1 above).

Paste the entire block below and click **Run**:

```sql
-- A.1  add the column
alter table public.customers
  add column if not exists "userId" uuid;

-- A.2  point it at auth.users (FK; null if the auth user is deleted)
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

-- A.3  one auth user → at most one customer
create unique index if not exists customers_userId_unique
  on public.customers("userId")
  where "userId" is not null;

-- A.4  fast lookups for the RLS policy
create index if not exists customers_userId_idx
  on public.customers("userId");
```

**Verify** (run in the same SQL editor):

```sql
select count(*) as total,
       count("userId") as linked,
       count(*) filter (where "userId" is null) as unlinked
from public.customers;
```

Expected: `total > 0`, `linked = 0`, `unlinked = total`.
That's correct — Step B is what populates `linked`.

✅ When you see those numbers, move on.

---

## STEP B — Deploy + run the auth backfill (~10 min)

**B.1  Create the function file locally**

In your local clone of the customer-portal repo:

```bash
mkdir -p supabase/functions/customer-auth-backfill
```

Then create `supabase/functions/customer-auth-backfill/index.ts` with
the contents already saved at:

```
supabase/migrations/20260427_customer_auth_backfill_README.md
```

(scroll to the *"Edge function source"* section and copy the TypeScript
block verbatim).

**B.2  Deploy it**

```bash
supabase login                                   # one-time
supabase link --project-ref obtmrrbajlrdnmnfhcas # one-time
supabase functions deploy customer-auth-backfill --no-verify-jwt
```

**B.3  Invoke it**

Export your service role key in the terminal (don't put it in a script
that gets committed):

```bash
export SUPABASE_SERVICE_ROLE_KEY='eyJhbGc...'   # from Dashboard → Settings → API
```

Then run:

```bash
curl -X POST \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  https://obtmrrbajlrdnmnfhcas.supabase.co/functions/v1/customer-auth-backfill \
  -d '{}'
```

**Expected response** (numbers will differ):

```json
{
  "processed": 137,
  "linked": 134,
  "skipped": 0,
  "errors": [
    { "customerId": "abc...", "reason": "no email on file" }
  ]
}
```

Re-run the same `curl` if you fix any errors. It's idempotent — already-
linked rows are skipped.

**B.4  Verify in the SQL editor**

```sql
select count(*) as total,
       count("userId") as linked,
       count(*) filter (where "userId" is null) as unlinked
from public.customers;
```

`linked` should now be `≈ total`. The few remaining `unlinked` rows are
typically customers with no email on file — they'll keep working through
the `customer-jobs` edge function (service-role) even after RLS is on,
because that function bypasses RLS by design.

✅ When `linked ≈ total`, move on.

---

## STEP C — Turn RLS on (~2 min)

**Where:** SQL Editor (tab #1).

Open the file `supabase/migrations/20260429_option_a_rls_enable.sql` in
your editor, copy its entire contents, paste into the SQL editor, and
click **Run**.

It will:
- abort if Step A wasn't applied (pre-flight check),
- print a `NOTICE` if any customers still have NULL `userId` (just info),
- enable RLS on `customers`, `jobs`, `quality_control`,
  `item_stage_tracking`,
- install one SELECT policy per table scoped to `auth.uid()`.

**Verify policies are live:**

```sql
-- RLS enabled?
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('customers','jobs','quality_control','item_stage_tracking');
-- Expected: relrowsecurity = true on all 4 rows.

-- Policies exist?
select schemaname, tablename, policyname
from pg_policies
where schemaname = 'public'
  and tablename in ('customers','jobs','quality_control','item_stage_tracking');
-- Expected: 4 rows.
```

✅ At this point the Supabase security finding is closed.

---

## STEP D — Verify in the browser (~5 min)

1. Hard-refresh the deployed portal (Ctrl/Cmd-Shift-R).
2. Sign in as a **backfilled** customer. Two ways to get one:
   - **Easiest:** create a fresh test customer in the dashboard, run
     Step B once more, then use Supabase Auth's "send recovery email"
     to set a password you know.
   - **Alternatively:** any existing customer who logs in successfully
     via the legacy `secure-login` path will keep working — the data
     path falls through to the `customer-jobs` edge function (service
     role), which bypasses RLS.
3. **DevTools → Network tab** — confirm requests to
   `/rest/v1/customers?...` and `/rest/v1/jobs?...` return rows
   (not `[]`).
4. **DevTools → Console** — paste the cross-tenant leak test:

   ```js
   const { data } = await window.supabase
     .from('jobs')
     .select('id')
     .eq('customerName', 'Some Other Customer Pty Ltd');  // a customer that's NOT you
   console.log('LEAK?', data);   // MUST be []
   ```

   If it returns `[]`, RLS is working. If it returns rows, run the
   rollback at the bottom of `20260429_option_a_rls_enable.sql` and
   ping me.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| One customer's portal is empty after Step C | Their `customers."userId"` is NULL | Re-run Step B; or set manually: `update public.customers set "userId" = '<auth.users.id>' where id = '<customer.id>';` |
| EVERY customer is empty | Frontend isn't actually sending an Auth JWT | Hard-refresh; check DevTools sees a `/auth/v1/token` request after login |
| `customer-jobs` returns 401 | Edge function lost its env vars | `supabase secrets list` — re-set `SUPABASE_SERVICE_ROLE_KEY` if missing |

**Full rollback** (restores pre-Step-C visibility) — paste into SQL editor:

```sql
alter table public.customers           disable row level security;
alter table public.jobs                disable row level security;
alter table public.quality_control     disable row level security;
alter table public.item_stage_tracking disable row level security;

drop policy if exists "customers_select_own"     on public.customers;
drop policy if exists "jobs_select_own_customer" on public.jobs;
drop policy if exists "qc_select_own_customer"   on public.quality_control;
drop policy if exists "ist_select_own_customer"  on public.item_stage_tracking;
drop function if exists public.current_customer_name();
```

No data is ever modified by any of these steps — only row-visibility
rules and one new column. Total worst-case rollback time: under a
minute.
