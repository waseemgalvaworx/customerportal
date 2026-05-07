# Re-enable RLS — Option A (Real Supabase Auth) — STEP-BY-STEP

This guide closes the **critical security finding** flagged by Supabase:
the `customers`, `jobs`, `quality_control`, and `item_stage_tracking`
tables currently have **Row Level Security DISABLED**, so anyone with the
publishable anon key can read every customer's data directly.

We previously couldn't enable RLS because the portal used the legacy
`secure-login` flow, which never populated `auth.uid()` — turning RLS on
made every query return zero rows.

**Option A** fixes this properly by migrating every customer to a real
Supabase Auth user. The frontend now tries `signInWithPassword(...)`
first and falls back to `secure-login` for accounts that haven't been
migrated yet, so the portal never breaks during the rollout.

---

## TL;DR — Order of operations

| Step | Where | What | Reversible? |
|------|-------|------|-------------|
| 0 | Frontend | Already done — `PasswordAuthContext.tsx` updated to try Supabase Auth first | n/a |
| A | SQL editor on `obtmrrbajlrdnmnfhcas` | Add `customers."userId"` column (idempotent) | yes |
| B | Supabase CLI on your laptop | Deploy + invoke `customer-auth-backfill` edge function | yes (delete the function) |
| C | SQL editor on `obtmrrbajlrdnmnfhcas` | Run `20260429_option_a_rls_enable.sql` | yes (rollback at bottom of file) |
| D | Browser | Verify a portal login still loads jobs | n/a |

Allow ~30 minutes end-to-end. **DO NOT run Step C before Step B succeeds**
for every active customer — RLS will hide their data otherwise (until
they're backfilled).

---

## STEP A — Add `customers."userId"` (skip if already applied)

Open the SQL editor for the **`obtmrrbajlrdnmnfhcas`** project and run
the contents of `20260427_customers_user_id.sql`. It's idempotent — safe
to re-run.

Quick verify:

```sql
select count(*) total,
       count("userId") linked,
       count(*) filter (where "userId" is null) unlinked
from public.customers;
```

`unlinked` is allowed to be > 0 at this stage; Step B fixes it.

---

## STEP B — Backfill auth.users for every customer

This is the step that actually enables `auth.uid()` to work.

### B.1  Save the function source locally

In your local checkout of the customer-portal repo, create:

```
supabase/functions/customer-auth-backfill/index.ts
```

…with the following contents:

```ts
// supabase/functions/customer-auth-backfill/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = {
    processed: 0,
    linked: 0,
    skipped: 0,
    errors: [] as Array<{ customerId: string; reason: string }>,
  };

  const PAGE = 50;
  let offset = 0;

  while (true) {
    const { data: customers, error } = await admin
      .from('customers')
      .select('id, name, email, "userId"')
      .is('userId', null)
      .range(offset, offset + PAGE - 1);

    if (error) {
      return new Response(
        JSON.stringify({ ...result, fatal: error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }

    if (!customers || customers.length === 0) break;

    for (const c of customers as any[]) {
      result.processed++;
      if (c.userId) { result.skipped++; continue; }

      const email: string | null = c.email ?? null;
      if (!email) {
        result.errors.push({ customerId: c.id, reason: 'no email on file' });
        continue;
      }

      // Seed every backfilled account with a strong random password. Users
      // will reset via "forgot password" the first time they log in via Auth.
      const seedPassword = crypto.randomUUID() + crypto.randomUUID();

      let authUserId: string | null = null;

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: seedPassword,
        email_confirm: true,
        user_metadata: {
          customer_id: c.id,
          customer_name: c.name,
          source: 'customer-auth-backfill',
        },
      });

      if (created?.user) {
        authUserId = created.user.id;
      } else if (createErr) {
        // Most common cause: email already exists in auth.users from a
        // previous run. Recover by listing and matching.
        const lower = email.toLowerCase();
        let page = 1;
        while (page <= 50 && !authUserId) {
          const { data: list } = await admin.auth.admin.listUsers({ page, perPage: 200 });
          const match = list?.users?.find((u: any) => (u.email ?? '').toLowerCase() === lower);
          if (match) { authUserId = match.id; break; }
          if (!list?.users || list.users.length < 200) break;
          page++;
        }
        if (!authUserId) {
          result.errors.push({ customerId: c.id, reason: createErr.message });
          continue;
        }
      }

      if (!authUserId) {
        result.errors.push({ customerId: c.id, reason: 'createUser returned no id' });
        continue;
      }

      const { error: updateErr } = await admin
        .from('customers')
        .update({ userId: authUserId })
        .eq('id', c.id)
        .is('userId', null);

      if (updateErr) {
        result.errors.push({ customerId: c.id, reason: `update failed: ${updateErr.message}` });
        continue;
      }

      result.linked++;
    }

    if (customers.length < PAGE) break;
    offset += PAGE;
  }

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
});
```

### B.2  Deploy + invoke

```bash
# One-time link (skip if already linked)
supabase login
supabase link --project-ref obtmrrbajlrdnmnfhcas

# Deploy
supabase functions deploy customer-auth-backfill --no-verify-jwt

# Invoke (auth header uses your service role key — never commit this!)
curl -X POST \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  https://obtmrrbajlrdnmnfhcas.supabase.co/functions/v1/customer-auth-backfill \
  -d '{}'
```

Expected response:

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

Re-run after fixing any `errors` rows (most are customers with no email
on file — those will keep using `secure-login` indefinitely, which is
fine; they read data via the service-role-backed `customer-jobs`
function).

### B.3  Confirm before continuing

```sql
select count(*) total,
       count("userId") linked,
       count(*) filter (where "userId" is null) unlinked
from public.customers;
```

`linked` should now be ~equal to `total` (minus any deliberate
no-email/disabled accounts). Move on once you're satisfied.

### B.4  (Optional) Send password-reset emails so users can log in via Auth

The seed passwords from Step B.2 are random and unknown to anyone, so
backfilled users CANNOT yet log in via the new Auth path — they'll keep
using `secure-login` until they reset. To migrate them off the legacy
path, send each one a recovery email:

```ts
await admin.auth.admin.generateLink({
  type: 'recovery',
  email: customer.email,
});
```

This is OPTIONAL — the dual-path login means everything keeps working
either way. You can run this rollout email by email, or in a single
batch, on your own schedule.

---

## STEP C — Turn RLS on

Open the SQL editor for **`obtmrrbajlrdnmnfhcas`** and run the contents of:

```
supabase/migrations/20260429_option_a_rls_enable.sql
```

The script is idempotent and includes a pre-flight check that fails
loudly if Step A wasn't applied. It also prints a `NOTICE` telling you
how many customers still don't have a `userId` (those will only be
reachable via the `customer-jobs` edge function — no data loss, just a
flag for follow-up).

Once it returns `Success. No rows returned`, the security finding is
closed.

---

## STEP D — Verify in the browser

1. Hard-refresh the portal (Ctrl/Cmd-Shift-R) so the new bundle loads.
2. Sign in as a **backfilled** customer (one with `customers."userId"` set
   to an `auth.users.id` AND who has reset their password — or use a
   newly-created test customer where you know the password).
   - For unmigrated customers using `secure-login`, the portal still
     works because the data path goes through the `customer-jobs` edge
     function.
3. DevTools → Network → confirm requests to
   `/rest/v1/customers?...` and `/rest/v1/jobs?...` return rows (not `[]`).
4. DevTools → Console — paste this cross-tenant leak test:

   ```js
   const { data } = await supabase
     .from('jobs')
     .select('id')
     .eq('customerName', 'Some Other Customer Pty Ltd');
   console.log('LEAK?', data);   // MUST be []
   ```

   If `data` has rows, RLS is misconfigured — apply the rollback at the
   bottom of `20260429_option_a_rls_enable.sql` and re-investigate.

---

## What if data DOES disappear after Step C?

Don't panic — there are exactly three possible causes, all easy to fix:

| Symptom | Cause | Fix |
|---------|-------|-----|
| One specific customer's tabs are empty after they sign in | Their `customers."userId"` is still NULL (Step B didn't link them) | Re-run Step B; or fix manually with `update public.customers set "userId" = '<auth.users.id>' where id = '<customer.id>';` |
| EVERY customer's tabs are empty (even the test customer that worked yesterday) | The frontend isn't actually authenticating via Supabase Auth — `auth.uid()` is null | Check that PasswordAuthContext.tsx is the new version (search for `signInWithPassword`). Hard-refresh. Check the DevTools network tab for a `/auth/v1/token` request after sign-in. |
| New `customer-jobs` calls return 401 | Edge function lost its env vars | `supabase secrets list` — set `SUPABASE_SERVICE_ROLE_KEY` if missing |

**Full rollback** (restore zero-RLS state from this morning) is at the
bottom of `20260429_option_a_rls_enable.sql`. Total cost: ~10 seconds of
SQL. The data itself is never modified, only the row-visibility rules.

---

## After everything works — clean up

Once every active customer has been password-reset and logs in via the
new Auth path (you can monitor this by counting Auth sign-ins vs.
`secure-login` invocations in the function logs), you can:

1. Remove the `secure-login` fallback branch from
   `PasswordAuthContext.tsx`.
2. Decommission the `secure-login` edge function:
   ```bash
   supabase functions delete secure-login
   ```
3. (Optional) Drop the legacy `public.users` table if nothing else
   references it.

That's the end-state: a single sign-in path, RLS enforced everywhere,
no service-role bypass except for explicit admin tooling.
