-- ════════════════════════════════════════════════════════════════════════════
-- CUSTOMER AUTH BACKFILL — pure SQL version  (revised 2026-05-06)
-- Run this entire file in Supabase SQL Editor (it must run as the postgres
-- superuser, which is the default in the dashboard SQL Editor).
--
-- WHAT IT DOES
--   For every row in public.customers where "userId" IS NULL and email IS NOT
--   NULL, it either
--     (a) finds the matching row in auth.users by email (case-insensitive)
--         and links customers."userId" to that uid, or
--     (b) creates a new auth.users row with a random bcrypt password,
--         marks email as confirmed, and links customers."userId" to it.
--
--   It is idempotent and re-runnable — rows that are already linked are
--   skipped, and rows whose email already exists in auth.users are linked to
--   the existing uid instead of being recreated.
--
-- ────────────────────────────────────────────────────────────────────────────
-- DUPLICATE-EMAIL HANDLING (NEW — fixes the unique-constraint error)
--
--   public.customers has a partial UNIQUE index `customers_userId_unique` on
--   ("userId") WHERE "userId" IS NOT NULL — i.e. one auth user can be linked
--   to at most ONE customer row. But the legacy data contains multiple
--   customer rows that share the same email address (e.g. duplicate jobs for
--   the same person entered as separate customer records over time).
--
--   When the previous version of this script encountered the second customer
--   row for an already-linked email it threw:
--      ERROR 23505: duplicate key value violates unique constraint
--                   "customers_userid_unique"
--      Key ("userId")=(...) already exists.
--   …and rolled back the entire DO block.
--
--   This revision detects that case BEFORE attempting the UPDATE, skips the
--   second/third/... duplicate, and reports them in the post-run audit so you
--   can decide how to merge or relabel them by hand.
-- ════════════════════════════════════════════════════════════════════════════

-- pgcrypto provides crypt() / gen_salt('bf') for bcrypt password hashing,
-- which is what GoTrue (Supabase Auth) uses internally.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────────────────────
-- IMPORTANT: This project has a user-defined trigger on auth.users
-- (handle_new_user) that tries to write to public.profiles.email, but that
-- column doesn't exist on this schema. We disable USER triggers on auth.users
-- for the duration of the backfill, then re-enable them. This does NOT touch
-- the internal Supabase/GoTrue triggers (those are system triggers and are
-- not affected by `DISABLE TRIGGER USER`).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE auth.users DISABLE TRIGGER USER;

-- ────────────────────────────────────────────────────────────────────────────
-- Scratch table to record duplicate-email customers we had to skip.
--
-- HISTORY:
--   The previous revision used a TEMP table here (`CREATE TEMP TABLE
--   _backfill_duplicates ...`). That failed inside the SQL Editor with:
--     ERROR 42P01: relation "_backfill_duplicates" does not exist
--   …because the Supabase SQL Editor executes top-level statements in
--   separate sessions/transactions in some configurations, so the TEMP
--   table created at the top of the script was no longer visible to the
--   subsequent DO $$ ... $$ block (TEMP tables are session-scoped, and a
--   different session can't see them).
--
--   We therefore use a REGULAR (non-TEMP) table in the `public` schema. It
--   is dropped + recreated at the start of every run, so re-running this
--   migration is still idempotent. The post-run audit reads from it, and
--   you can drop it manually with `DROP TABLE public._backfill_duplicates;`
--   once you've reviewed the results.
-- ────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS public._backfill_duplicates;
CREATE TABLE public._backfill_duplicates (
  customer_id        uuid,
  customer_name      text,
  email              text,
  conflicting_userid uuid,
  reason             text
);


DO $$
DECLARE
  c            RECORD;
  v_uid        uuid;
  v_existing   uuid;
  v_already_linked_to uuid;
  v_processed  int := 0;
  v_linked_existing int := 0;
  v_created    int := 0;
  v_skipped_no_email int := 0;
  v_skipped_dup_email int := 0;
  v_skipped_too_long int := 0;
  v_errors     int := 0;
BEGIN

  FOR c IN
    SELECT id, name, email
    FROM public.customers
    WHERE "userId" IS NULL
    -- Process rows in a stable order so the "first" customer for any given
    -- email always wins the link, deterministically.
    --
    -- NOTE: this project's `public.customers` table mixes naming conventions —
    -- `"userId"` is camelCase (and therefore quoted) but the timestamp column
    -- is snake_case `created_at` (unquoted). An earlier revision of this
    -- script used `"createdAt"` and failed with:
    --     ERROR 42703: column "createdAt" does not exist
    --     HINT: Perhaps you meant to reference the column "customers.created_at".
    -- We use `created_at` here. If your schema happens to use `"createdAt"`
    -- instead, swap the identifier on the next line.
    ORDER BY email NULLS LAST, created_at NULLS LAST, id
  LOOP

    v_processed := v_processed + 1;

    -- Skip rows with no email — they cannot be migrated to Auth.
    IF c.email IS NULL OR btrim(c.email) = '' THEN
      v_skipped_no_email := v_skipped_no_email + 1;
      CONTINUE;
    END IF;

    -- ──────────────────────────────────────────────────────────────────────
    -- LENGTH GUARD (NEW — fixes the 22001 string_data_right_truncation error)
    --
    -- The previous revision aborted the entire DO block with:
    --     ERROR 22001: value too long for type character varying(255)
    -- …raised from inside the auth.users INSERT below. Several columns on
    -- auth.users are typed as varchar(255) (depending on the GoTrue schema
    -- version this project is on, e.g. `aud`, `role`, `email`, the various
    -- `*_token` / `email_change` / `phone_change` columns, etc.). The only
    -- value we substitute that's user-supplied is `c.email`, so an email
    -- address longer than ~255 characters in the source data will overflow.
    --
    -- We pre-emptively skip any row whose email (after lower+btrim) is
    -- longer than 254 chars and record it in _backfill_duplicates so the
    -- operator can clean the source row by hand. 254 (not 255) leaves a
    -- safety margin for any internal whitespace/casing normalisation
    -- GoTrue might apply on top of ours.
    -- ──────────────────────────────────────────────────────────────────────
    IF length(lower(btrim(c.email))) > 254 THEN
      INSERT INTO public._backfill_duplicates
        (customer_id, customer_name, email, conflicting_userid, reason)
      VALUES
        (c.id, c.name, c.email, NULL,
         'email longer than 254 chars — would overflow auth.users varchar(255)');
      v_skipped_too_long := v_skipped_too_long + 1;
      CONTINUE;
    END IF;

    -- 1) Try to find an existing auth.users row by email (case-insensitive).
    SELECT id INTO v_existing
    FROM auth.users
    WHERE lower(email) = lower(btrim(c.email))
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
      v_uid := v_existing;
      v_linked_existing := v_linked_existing + 1;
    ELSE
      -- 2) Create a brand-new auth.users row.
      v_uid := gen_random_uuid();

      BEGIN
        INSERT INTO auth.users (
          instance_id,
          id,
          aud,
          role,
          email,
          encrypted_password,
          email_confirmed_at,
          invited_at,
          confirmation_token,
          confirmation_sent_at,
          recovery_token,
          recovery_sent_at,
          email_change_token_new,
          email_change,
          email_change_sent_at,
          last_sign_in_at,
          raw_app_meta_data,
          raw_user_meta_data,
          is_super_admin,
          created_at,
          updated_at,
          phone,
          phone_confirmed_at,
          phone_change,
          phone_change_token,
          phone_change_sent_at,
          email_change_token_current,
          email_change_confirm_status,
          banned_until,
          reauthentication_token,
          reauthentication_sent_at,
          is_sso_user,
          is_anonymous
        ) VALUES (
          '00000000-0000-0000-0000-000000000000',
          v_uid,
          'authenticated',
          'authenticated',
          lower(btrim(c.email)),
          crypt(replace(gen_random_uuid()::text, '-', '') ||
                replace(gen_random_uuid()::text, '-', ''),
                gen_salt('bf')),
          now(),
          NULL,
          '',
          NULL,
          '',
          NULL,
          '',
          '',
          NULL,
          NULL,
          jsonb_build_object('provider','email','providers',ARRAY['email']),
          jsonb_build_object(
            'customer_id',   c.id,
            'customer_name', c.name,
            'source',        'sql-backfill-20260506'
          ),
          false,
          now(),
          now(),
          NULL,
          NULL,
          '',
          '',
          NULL,
          '',
          0,
          NULL,
          '',
          NULL,
          false,
          false
        );

        -- Mirror identity row so signInWithPassword works.
        INSERT INTO auth.identities (
          id,
          user_id,
          identity_data,
          provider,
          provider_id,
          last_sign_in_at,
          created_at,
          updated_at
        ) VALUES (
          gen_random_uuid(),
          v_uid,
          jsonb_build_object(
            'sub',            v_uid::text,
            'email',          lower(btrim(c.email)),
            'email_verified', true,
            'provider',       'email'
          ),
          'email',
          lower(btrim(c.email)),
          NULL,
          now(),
          now()
        );

        v_created := v_created + 1;
      EXCEPTION
        WHEN unique_violation THEN
          -- Race: someone (or another row in this same loop with a duplicate
          -- email) already created an auth user. Recover by lookup.
          SELECT id INTO v_uid
          FROM auth.users
          WHERE lower(email) = lower(btrim(c.email))
          LIMIT 1;

          IF v_uid IS NULL THEN
            v_errors := v_errors + 1;
            CONTINUE;
          END IF;
          v_linked_existing := v_linked_existing + 1;

        WHEN string_data_right_truncation THEN
          -- A varchar(255) column on auth.users overflowed. The length
          -- guard above catches the obvious case (long email), so reaching
          -- this handler means some OTHER value we passed (e.g. a column
          -- whose type changed in a newer GoTrue migration) doesn't fit.
          -- Record the row and continue with the rest of the backfill
          -- instead of aborting the whole DO block.
          INSERT INTO public._backfill_duplicates
            (customer_id, customer_name, email, conflicting_userid, reason)
          VALUES
            (c.id, c.name, c.email, NULL,
             'string_data_right_truncation (22001) on INSERT INTO auth.users — ' ||
             'one of the varchar(255) columns overflowed; clean this row by hand');
          v_skipped_too_long := v_skipped_too_long + 1;
          CONTINUE;

        WHEN OTHERS THEN
          -- Any other error on this single row: log and keep going. The
          -- whole-DO-block-rollback semantics of an unhandled exception
          -- are exactly what we are trying to avoid here.
          INSERT INTO public._backfill_duplicates
            (customer_id, customer_name, email, conflicting_userid, reason)
          VALUES
            (c.id, c.name, c.email, NULL,
             'unexpected error on INSERT INTO auth.users: ' || SQLSTATE || ' ' || SQLERRM);
          v_errors := v_errors + 1;
          CONTINUE;
      END;
    END IF;

    -- 3) Link customers."userId" → v_uid (only if still NULL).
    --
    --    BUT first: customers has a partial UNIQUE index on "userId", so if
    --    another customer row is ALREADY linked to v_uid (because the same
    --    email appears on multiple customer rows), we cannot link this one.
    --    Record it in _backfill_duplicates and skip — the caller can decide
    --    later whether to merge the customer records or attach a different
    --    auth user.

    SELECT id INTO v_already_linked_to
    FROM public.customers
    WHERE "userId" = v_uid
      AND id <> c.id
    LIMIT 1;

    IF v_already_linked_to IS NOT NULL THEN
      INSERT INTO public._backfill_duplicates
        (customer_id, customer_name, email, conflicting_userid, reason)
      VALUES
        (c.id, c.name, c.email, v_uid,
         'auth user already linked to customer ' || v_already_linked_to::text);
      v_skipped_dup_email := v_skipped_dup_email + 1;
      CONTINUE;
    END IF;


    -- Defensive: even with the pre-check above, two concurrent sessions could
    -- both pass the check and then race on the UPDATE. Catch the unique
    -- violation instead of aborting the whole DO block.
    BEGIN
      UPDATE public.customers
         SET "userId" = v_uid
       WHERE id = c.id
         AND "userId" IS NULL;
    EXCEPTION WHEN unique_violation THEN
      INSERT INTO public._backfill_duplicates
        (customer_id, customer_name, email, conflicting_userid, reason)
      VALUES
        (c.id, c.name, c.email, v_uid,
         'unique_violation on UPDATE customers.userId');
      v_skipped_dup_email := v_skipped_dup_email + 1;
    END;

  END LOOP;

  RAISE NOTICE 'Backfill complete: processed=%, created=%, linked_to_existing=%, skipped_no_email=%, skipped_dup_email=%, skipped_too_long=%, errors=%',
    v_processed, v_created, v_linked_existing, v_skipped_no_email, v_skipped_dup_email, v_skipped_too_long, v_errors;

END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Re-enable user-defined triggers on auth.users now that the backfill is done.
-- The handle_new_user() trigger is broken (refers to a non-existent
-- profiles.email column) and should be fixed separately, but we restore the
-- original ENABLE state so we don't change schema behaviour beyond the scope
-- of this migration.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE auth.users ENABLE TRIGGER USER;


-- ════════════════════════════════════════════════════════════════════════════
-- POST-RUN AUDIT
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Top-level link counts.
SELECT
  count(*)                                       AS total,
  count("userId")                                AS linked,
  count(*) FILTER (WHERE "userId" IS NULL)       AS unlinked,
  count(*) FILTER (WHERE "userId" IS NULL AND email IS NULL) AS unlinked_no_email,
  count(*) FILTER (WHERE "userId" IS NULL AND email IS NOT NULL) AS unlinked_with_email
FROM public.customers;

-- 2) Customers we couldn't link this run because their email was already
--    claimed by another customer row. Review these and decide whether to
--    merge the duplicate customer records.
SELECT * FROM public._backfill_duplicates ORDER BY email, customer_id;


-- 3) Email addresses that appear on more than one customer row. Any of these
--    will only ever be linkable to ONE customer row given the partial UNIQUE
--    index on customers."userId" — the others need to be merged or given a
--    distinct email.
SELECT
  lower(btrim(email)) AS email_norm,
  count(*)            AS customer_rows,
  array_agg(id ORDER BY id) AS customer_ids,
  array_agg("userId" ORDER BY id) AS user_ids
FROM public.customers
WHERE email IS NOT NULL AND btrim(email) <> ''
GROUP BY lower(btrim(email))
HAVING count(*) > 1
ORDER BY count(*) DESC, email_norm;
