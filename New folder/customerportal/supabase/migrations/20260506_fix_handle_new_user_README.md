# Fix broken `public.handle_new_user()` trigger on `auth.users`

## The bug

The legacy `public.handle_new_user()` AFTER-INSERT trigger on `auth.users` is:

```sql
INSERT INTO public.profiles (id, email, full_name)
VALUES (new.id, new.email, new.raw_user_meta_data->>'full_name')
```

…but `public.profiles.email` does **not** exist on this project's database, so
**every** insert into `auth.users` fails with:

```
ERROR: 42703: column "email" of relation "profiles" does not exist
```

That blocks new signups, admin invites, and the `20260506_customer_auth_backfill_SQL.sql`
backfill script (the immediate trigger of this fix).

## Why I cannot inspect / fix it from this environment

The Famous build environment has a `run_supabase_query` tool, but it is wired to
the Famous-internal Supabase project, **not** the customer-portal Supabase
project (`obtmrrbajlrdnmnfhcas.supabase.co`) where `public.profiles` and
`handle_new_user()` actually live. So this fix is delivered as a SQL migration
you run yourself in the Supabase SQL Editor.

## What the migration does

`20260506_fix_handle_new_user.sql` is **option (b)**: fix the trigger, do not
add the missing column. The customer-portal app never reads or writes
`public.profiles` (verified by codebase search), so adding columns purely to
satisfy a legacy trigger would be cargo-culted dead schema.

The script:

1. **Inspects** `public.profiles` via `information_schema.columns` to discover
   which of `id`, `email`, `full_name`, `name`, `avatar_url`, `created_at`,
   `updated_at` actually exist.
2. **Rewrites** `public.handle_new_user()` with a dynamically generated
   `INSERT` that mentions only the columns that exist. The body is wrapped in
   `EXCEPTION WHEN OTHERS` so future schema drift (or a missing FK) **cannot
   block `auth.users` inserts again** — failures become `RAISE WARNING`s
   instead of fatal errors. `ON CONFLICT (id) DO NOTHING` keeps the function
   idempotent.
3. **Wires the trigger** (`on_auth_user_created` AFTER INSERT ON `auth.users`)
   if it isn't already attached.
4. **Verifies** by inserting a synthetic test row into `auth.users`, asserting
   no exception was raised, then `DELETE`ing the test user. If the trigger is
   still broken, the verification block raises a clear error pointing at the
   function definition.
5. If `public.profiles` doesn't exist at all, installs a no-op
   `handle_new_user()` so it can never block `auth.users` again.

The script uses `CREATE OR REPLACE` everywhere and is safe to re-run.

## Running it

1. Open the Supabase Dashboard for project `obtmrrbajlrdnmnfhcas`.
2. SQL Editor → New query → paste the entire contents of
   `supabase/migrations/20260506_fix_handle_new_user.sql`.
3. Run.
4. Watch the **Messages** tab. You should see, in order:
   - `public.profiles columns detected — id=…, email=…, full_name=…, …`
   - `Installing handle_new_user() with INSERT INTO public.profiles (…) VALUES (…)`
   - `Trigger on_auth_user_created already exists; left in place.` *(or `Created trigger …` on first run)*
   - `VERIFY: auth.users insert succeeded; matching public.profiles rows = 0 or 1`
   - `VERIFY: cleanup complete (test user deleted).`

If any line says `VERIFY FAILED`, copy the full error text — it contains the
exact `SQLSTATE` and `SQLERRM` plus the SQL needed to dump the current function
body.

## After running

Re-run `20260506_customer_auth_backfill_SQL.sql`. The `ALTER TABLE auth.users
DISABLE TRIGGER USER` / `ENABLE TRIGGER USER` dance in that file is now
unnecessary (the trigger is no longer broken) but it is harmless to leave —
it's a defensive belt-and-braces guard.

## Option A — add the missing column instead

If you actually want `public.profiles` to mirror `auth.users.email`, scroll
to the bottom of the migration file and uncomment the `OPTION A` block. It
adds `email`, `full_name`, `created_at`, `updated_at` to `public.profiles`,
indexes `lower(email)`, and backfills from `auth.users`. After running it,
re-run STEP 1 of the same file so the trigger picks up the now-existing
columns dynamically.
