# Customer Auth Backfill — Duplicate-Email Handling (2026-05-06 revision)

## What changed and why

The first run of `20260506_customer_auth_backfill_SQL.sql` aborted with:

```
ERROR:  23505: duplicate key value violates unique constraint
        "customers_userid_unique"
DETAIL: Key ("userId")=(544339ff-c0a7-4317-976d-878757933bd8) already exists.
CONTEXT: SQL statement "UPDATE public.customers
                          SET "userId" = v_uid
                        WHERE id = c.id
                          AND "userId" IS NULL"
```

### Root cause

`public.customers` has a partial unique index installed by
`20260427_customers_user_id.sql`:

```sql
create unique index if not exists customers_userId_unique
  on public.customers("userId")
  where "userId" is not null;
```

This enforces **one auth user → at most one customer row**.

The legacy data, however, contains multiple customer rows that share the
**same email address** — likely from operators creating a fresh customer
record per repeat job instead of reusing the existing one. When the script
processed the first such row it created (or located) an auth user and linked
it. When it then reached the second row with the same email it resolved to
the same auth uid and tried to write it onto a different customer row,
violating the unique index.

Because the entire script runs inside a single `DO $$ ... $$` block, that
exception rolled back **all** of the linking work it had just done.

### Fix

The revised script:

1. **Pre-checks** before each `UPDATE` whether `v_uid` is already in use by
   another `customers` row, and skips those rows instead of blowing up.
2. **Wraps** the `UPDATE` itself in a per-row `EXCEPTION WHEN
   unique_violation` handler as a defensive belt-and-braces in case of
   concurrent sessions.
3. **Records** every skipped duplicate in a `_backfill_duplicates` TEMP
   table with the customer id, name, email, conflicting auth uid and the
   reason — so you have a worklist for manual cleanup.
4. **Processes rows in deterministic order** (`ORDER BY email NULLS LAST,
   "createdAt" NULLS LAST, id`) so the *first* customer row for any given
   email always wins the link, no matter how many times you re-run.

## How to run

Open the Supabase dashboard SQL editor and run the entire contents of
`20260506_customer_auth_backfill_SQL.sql`. Three result tables are
returned:

| # | What it tells you |
|---|---|
| 1 | High-level link counts — `total`, `linked`, `unlinked`, `unlinked_no_email`, `unlinked_with_email`. After a successful run `unlinked` should equal `unlinked_no_email + (number of duplicate customer rows you have)`. |
| 2 | `_backfill_duplicates` — every customer row that couldn't be linked because its email was already claimed by another customer row this run. Includes the conflicting auth uid. |
| 3 | Email addresses that appear on **more than one** customer row in `public.customers`. These are your underlying data-quality problem. |

Look in the **Messages** tab for the `RAISE NOTICE` line that summarizes
the run, e.g.

```
NOTICE:  Backfill complete: processed=332, created=287, linked_to_existing=11,
         skipped_no_email=4, skipped_dup_email=30, errors=0
```

## What to do about the leftovers

Each entry in result #2 / result #3 is a business decision, not a code
bug. You typically have three options per duplicate:

1. **Merge the customer rows** in `public.customers`. Re-point any
   referencing rows (`jobs.customerId`, `quality_control.customerId`, etc.)
   from the duplicate id to the canonical id, then `DELETE` the
   duplicate. The next run of the backfill leaves the canonical row's
   link intact.
2. **Give the duplicate a distinct email** (e.g. append `+job2` —
   `gmail.com` and most providers accept `user+tag@gmail.com`
   addressing). Re-run the backfill and it'll create a fresh auth user
   for the new address.
3. **Leave it unlinked**. The customer keeps using the legacy
   `secure-login` path until you've cleaned up the data. RLS will block
   them once `20260427_customer_rls.sql` is applied, so don't enable RLS
   until result #2 is empty.

## Re-runnability

The revised script is fully idempotent:

- Customers already linked are skipped (the outer `WHERE "userId" IS NULL`).
- Customers whose email already has an `auth.users` row are linked to it
  rather than recreated.
- Customers whose email is now claimed by another `customers` row are
  recorded in `_backfill_duplicates` and skipped — they will reappear in
  result #2 on every subsequent run until you resolve them.

You can therefore safely run it as many times as you like while you
clean up the duplicates in batches.
