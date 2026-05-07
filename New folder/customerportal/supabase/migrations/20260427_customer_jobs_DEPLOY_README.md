# Deploying `customer-jobs` + linking portal users — STEP-BY-STEP

This is the fix for:

> `[Portal] fetch jobs failed — Failed to send a request to the Edge Function`
> `POST https://obtmrrbajlrdnmnfhcas.supabase.co/functions/v1/customer-jobs → status 0`

…and the follow-on symptom where, after the front-end was switched to call
`customer-jobs` exclusively, **all portal tabs were empty** for users like
`gs steel` (id `9bace170-565b-4829-9156-5b61256bad95`).

There are two independent root causes — fix BOTH:

| # | Problem | Symptom in the browser | Fix |
|---|---------|------------------------|-----|
| 1 | The `customer-jobs` edge function is not deployed to YOUR Supabase project (`obtmrrbajlrdnmnfhcas`). | `FunctionsFetchError: Failed to fetch` (network status 0) | **Step A** below — deploy it. |
| 2 | The `customers."userId"` column is not populated for some portal users. The function deploys fine but returns `404 / "No customer profile linked to this user"`, and the portal shows zero jobs. | Empty Active + History tabs after a successful 200 OK from the function (`meta.lookupMethod` would be empty / no jobs). | **Step B** below — run the backfill SQL. |

Apply Step A and Step B in order, then verify with Step C.

---

## STEP A — Deploy `customer-jobs` to YOUR Supabase project

The Famous tooling can only deploy edge functions to its own gateway project,
NOT to your customer-data project (`obtmrrbajlrdnmnfhcas`). You have to do
this from your own machine with the Supabase CLI.

### A.1  Copy the function source into your local repo

The full, ready-to-deploy source is in:

```
supabase/migrations/customer-jobs-edge-function.ts.txt
```

Copy it to:

```
supabase/functions/customer-jobs/index.ts
```

(The `.txt` extension only exists to keep Vite from compiling it as part of
the React bundle — the contents are unchanged TypeScript.)

### A.2  Link the CLI to your project (one-time)

```bash
# from your local checkout
supabase login
supabase link --project-ref obtmrrbajlrdnmnfhcas
```

### A.3  Deploy with JWT verification disabled

```bash
supabase functions deploy customer-jobs --no-verify-jwt
```

`--no-verify-jwt` is required because the customer portal authenticates
through your own `secure-login` edge function and stores the resulting
user object in `localStorage` — it does NOT use Supabase Auth, so there is
no JWT for the gateway to verify on subsequent requests. The function
itself uses the **service role key** internally to look up the
user → customer linkage, so authorisation is enforced server-side.

### A.4  Confirm the env vars exist on the function

```bash
supabase functions list
supabase secrets list
```

You need both of these set on the project (Supabase populates them by
default for every project, but double-check):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

If `SUPABASE_SERVICE_ROLE_KEY` is missing, set it explicitly:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="<the service role key>"
```

### A.5  Smoke-test the function

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  https://obtmrrbajlrdnmnfhcas.supabase.co/functions/v1/customer-jobs \
  -d '{
        "user": {
          "id": "9bace170-565b-4829-9156-5b61256bad95",
          "username": "gs steel",
          "role": "customer_portal"
        }
      }'
```

Expected response shapes:
- `200 OK` with `{ customer: {...}, jobs: [...], meta: {...} }` once Step B
  has been run.
- `404` with `{ error: "No customer profile linked...", jobs: [], customer: null }`
  if Step B hasn't been run yet — that's fine, it confirms deployment +
  CORS + service-role lookup are all working.

If you instead get `{"message":"NOT_FOUND"}` from the gateway, the
function isn't deployed yet — re-run Step A.3.

---

## STEP B — Backfill `customers."userId"` for ALL portal users

Open the Supabase SQL editor for `obtmrrbajlrdnmnfhcas` and run, in order:

1. **`20260427_customers_user_id.sql`** — adds the `customers."userId"`
   column + FK + indexes. (Skip if already applied.)
2. **`20260427_portal_users_userid_backfill.sql`** — links every
   `users.role IN ('customer_portal', 'customer')` row to its matching
   `customers` row.

The backfill applies three passes:

| Pass | Match rule                                                                 | Catches |
|------|----------------------------------------------------------------------------|---------|
| 1    | `customers.id = users.customer_id`                                         | Users whose `customer_id` is already populated. |
| 2    | `lower(trim(users.username)) = lower(trim(customers.name))` (collapsed whitespace), only when the match is unambiguous on both sides. | Users like **`gs steel`** whose `customer_id` is NULL but whose username matches a `customers.name` (case-insensitive). |
| 3    | `lower(trim(users.email)) = lower(trim(customers.email))`, only when both columns exist and the match is unambiguous on both sides. | Users whose display name differs from the company name but who share an email. |

It NEVER overwrites an existing non-null `userId` — safe to re-run.

Headline counts are printed at the end. You should see something like:

```
portal_users_total | portal_users_with_customer_id | customers_linked_before | customers_linked_after | newly_linked
-------------------+-------------------------------+-------------------------+------------------------+-------------
                42 |                            38 |                      35 |                     41 |           6
```

### B.1  Find any stragglers

If `newly_linked + customers_linked_before < portal_users_total`, some users
weren't auto-linkable. Run this to see who:

```sql
select u.id, u.username, u.role, u.customer_id
from public.users u
left join public.customers c on c."userId" = u.id
where lower(coalesce(u.role, '')) in ('customer_portal', 'customer')
  and c.id is null
order by u.username;
```

For each row, fix manually using the templates at the bottom of
`20260427_portal_users_userid_backfill.sql` (link an existing customer by
id, or create a new customer row, then update `users.customer_id` so the
link survives a future re-deploy).

---

## STEP C — Verify in the browser

1. Hard-refresh the portal (Ctrl/Cmd-Shift-R) so the new bundle loads.
2. Sign in as `gs steel` (or any portal user).
3. Open DevTools → Console. You should see:

   ```
   [Portal] Invoking customer-jobs edge function {username: "gs steel", ...}
   [Portal] customer-jobs result {customer: {id, name: "GS Steel"}, meta: {lookupMethod: "userId" | "user_id" | "username->name(ilike)", queryUsed: "customerId" | "customerName", rawCount: N, safeCount: N}}
   ```

4. Both **Active Jobs** and **History** tabs should populate.

If you still see `FunctionsFetchError: Failed to fetch` → **Step A** wasn't
completed (function isn't deployed in the right project).

If you see `[Portal] customer-jobs unreachable — falling back to defensive
client-side scoped query.` → the front-end's belt-and-braces fallback
kicked in. That fallback works as long as the customer record can be
resolved by `userId` / `user_id` / `customer_id` / username, so this
points to **Step B** also being incomplete for that user.

If the function returns 200 but the tabs are empty → run the straggler
query in **B.1** for that specific user.

---

## Why the front-end change alone wasn't enough

The earlier refactor switched the customer portal from
`supabase.from('jobs').select(...)` to
`supabase.functions.invoke('customer-jobs', ...)`. That removed the
client-side query path entirely, so when the function isn't deployed (or
returns 404 for an unlinked user) there's nothing to fall back to.

The current `CustomerPortal.tsx` mitigates this with a defensive
client-side fallback that runs ONLY when the function is unreachable
(network-level `FunctionsFetchError`). That fallback ALSO requires a
resolvable customer linkage — so Step B is mandatory regardless of which
path is in use.

Once both steps are complete, the SERVICE_ROLE-backed primary path wins
on every login and the fallback never runs.
