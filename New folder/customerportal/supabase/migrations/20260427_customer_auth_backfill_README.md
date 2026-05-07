# Customer Auth Backfill — One-Time Migration

This document describes how to migrate every existing customer in the
shared backend (`obtmrrbajlrdnmnfhcas`) from the legacy `secure-login`
password store to **real Supabase Auth users**, so that `auth.uid()` is
populated on the client and the RLS policies in
`20260427_customer_rls.sql` actually enforce.

## Order of operations

Apply these in order, top-down. Each step is idempotent.

1. **Schema** — `20260427_customers_user_id.sql`
   Adds `customers."userId"` (uuid, FK → `auth.users.id`, unique).

2. **Backfill** — deploy and invoke the `customer-auth-backfill` edge
   function (code below).
   For every customer row whose `userId` is NULL it:
     - reads the legacy `email` (and optional `password_hash`/`password`)
       fields from the existing `users` / `customers` row,
     - calls `supabase.auth.admin.createUser({ email, password,
       email_confirm: true })` with the service role key,
     - writes the resulting `auth.users.id` back to
       `public.customers."userId"`.

   The function is safe to re-run — it skips any customer that already
   has a `userId`, and on `email_exists` errors it falls back to
   `auth.admin.listUsers` / `getUserByEmail` to recover the existing
   uid.

3. **RLS** — `20260427_customer_rls.sql`
   Enables RLS on `customers` / `jobs` / `quality_control` /
   `item_stage_tracking` and adds the `customerName`-scoped policies.
   ONLY apply this after step 2 has succeeded for every active customer
   — otherwise customers will be locked out until they're backfilled.

## How to run the backfill

```bash
# 1. Deploy the edge function (the source is in
#    supabase/functions/customer-auth-backfill/index.ts — copy from the
#    "Edge function source" section below).
supabase functions deploy customer-auth-backfill --no-verify-jwt

# 2. Invoke it. The function ignores its body and processes ALL
#    customers with userId IS NULL, in batches of 50.
curl -X POST \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  https://obtmrrbajlrdnmnfhcas.supabase.co/functions/v1/customer-auth-backfill \
  -d '{}'

# Response shape:
# {
#   "processed": 137,
#   "linked":    134,
#   "skipped":   3,        // already had userId
#   "errors":    [{ "customerId": "...", "reason": "no email on file" }]
# }
```

Re-run until `errors` is empty (after fixing the underlying data — most
errors are customers with no email address, which can't be migrated to
Auth). Customers in the `errors` list will continue to use the legacy
`secure-login` path until they're fixed.

## Edge function source

Save as `supabase/functions/customer-auth-backfill/index.ts` (or paste
into the Supabase dashboard) and deploy. **This function MUST run with
the service role key** — it is the only role that can call
`auth.admin.createUser` and bypass RLS to update `customers."userId"`.

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

  // Service-role client — bypasses RLS and can use auth.admin.*
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = {
    processed: 0,
    linked: 0,
    skipped: 0,
    errors: [] as Array<{ customerId: string; reason: string }>,
  };

  // Fetch every customer that hasn't been linked yet.
  // We page in batches of 50 to keep memory bounded.
  const PAGE = 50;
  let offset = 0;

  while (true) {
    const { data: customers, error } = await admin
      .from('customers')
      .select('id, name, email, "userId", username, password, password_hash')
      .is('userId', null)
      .range(offset, offset + PAGE - 1);

    if (error) {
      return new Response(
        JSON.stringify({ ...result, fatal: error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }

    if (!customers || customers.length === 0) break;

    for (const c of customers) {
      result.processed++;

      // Skip if already linked (race-safe — another invocation may have
      // updated this row between the SELECT and now).
      if (c.userId) { result.skipped++; continue; }

      const email: string | null = c.email ?? null;
      if (!email) {
        result.errors.push({ customerId: c.id, reason: 'no email on file' });
        continue;
      }

      // Pick a password to seed the auth user with. Prefer the legacy
      // plaintext (if your old `secure-login` stored it), else generate
      // a strong random one and rely on the user resetting via email.
      const seedPassword: string =
        c.password ??
        crypto.randomUUID() + crypto.randomUUID();

      let authUserId: string | null = null;

      // 1. Try to create.
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
        // 2. Most likely cause of failure: the email already exists in
        //    auth.users (someone was migrated already, or a duplicate
        //    customer row exists). Recover by looking it up.
        const lower = email.toLowerCase();
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        const match = list?.users?.find((u) => (u.email ?? '').toLowerCase() === lower);
        if (match) {
          authUserId = match.id;
        } else {
          result.errors.push({ customerId: c.id, reason: createErr.message });
          continue;
        }
      }

      if (!authUserId) {
        result.errors.push({ customerId: c.id, reason: 'createUser returned no id' });
        continue;
      }

      // 3. Write the uid back to customers.userId.
      const { error: updateErr } = await admin
        .from('customers')
        .update({ userId: authUserId })
        .eq('id', c.id)
        .is('userId', null); // never overwrite an existing link

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

## After the backfill

- Customers whose email lives in `auth.users` can now sign in via
  `supabase.auth.signInWithPassword({ email, password })`. The web
  portal already attempts this path first (see
  `src/contexts/PasswordAuthContext.tsx`) and only falls back to
  `secure-login` for accounts that aren't yet migrated.

- Once `errors` is empty for an entire run, you can:
  1. Apply `20260427_customer_rls.sql` to turn RLS on.
  2. (Optional) Send a password-reset email to each customer with
     `admin.auth.admin.generateLink({ type: 'recovery', email })`,
     since the seed password is unknown to them.
  3. (Eventually) Decommission the `secure-login` edge function and
     remove its fallback branch from `PasswordAuthContext.tsx`.
