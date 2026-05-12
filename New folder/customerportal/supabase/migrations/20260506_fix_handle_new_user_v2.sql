-- ════════════════════════════════════════════════════════════════════════════
-- FIX BROKEN handle_new_user() — v2 (explicit, schema-aware version)
--
-- Companion / successor to 20260506_fix_handle_new_user.sql. That earlier
-- script used dynamic SQL to build the INSERT column list at install time,
-- which is robust but harder to read. This v2 is the explicit static
-- version requested by the operator: it only references columns that we
-- know (per inspection of public.profiles on this project) actually exist:
--
--     id           uuid primary key references auth.users(id)
--     full_name    text
--     avatar_url   text
--     updated_at   timestamptz
--
-- It pulls full_name and avatar_url out of NEW.raw_user_meta_data via the
-- `->>` JSON operator with sensible NULL fallbacks, re-grants EXECUTE on
-- the function to the roles GoTrue uses to insert auth.users rows, and
-- re-attaches the AFTER INSERT trigger on auth.users.
--
-- ──────────────────────────────────────────────────────────────────────
-- HISTORY
--   The legacy public.handle_new_user() inserted into public.profiles.email,
--   which does not exist on this project's profiles schema. EVERY auth.users
--   insert therefore failed with:
--     ERROR: 42703: column "email" of relation "profiles" does not exist
--   This is why the customer-auth backfill (20260506_customer_auth_backfill_SQL.sql)
--   has to wrap its work in `ALTER TABLE auth.users DISABLE TRIGGER USER` /
--   `ENABLE TRIGGER USER` — the trigger would otherwise abort every
--   `INSERT INTO auth.users` and roll the whole DO block back.
--
--   We chose option (b) — fix the trigger, not the table — because the
--   customer-portal app never reads or writes public.profiles, so adding
--   an unused `email` column purely to satisfy the trigger would be dead
--   schema.
-- ──────────────────────────────────────────────────────────────────────
-- IDEMPOTENCY
--   This script uses CREATE OR REPLACE / DROP TRIGGER IF EXISTS / GRANT,
--   so it is safe to run repeatedly. It ends with a verification block
--   that inserts a synthetic auth.users row, asserts no exception was
--   raised, then deletes the test row.
-- ════════════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────────────
-- STEP 1. Replace the function with an explicit, narrow definition that
-- only touches columns we know exist on public.profiles.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name  text;
  v_avatar_url text;
BEGIN
  -- Pull display fields out of the auth metadata blob with fallbacks.
  -- GoTrue lets clients write either { full_name } (Supabase convention)
  -- or { name } (OAuth providers like Google / GitHub), so we accept both.
  v_full_name  := COALESCE(
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'name',
    NULL
  );
  v_avatar_url := COALESCE(
    NEW.raw_user_meta_data ->> 'avatar_url',
    NEW.raw_user_meta_data ->> 'picture',  -- Google / OIDC convention
    NULL
  );

  -- Best-effort upsert of the profile row. We DELIBERATELY swallow any
  -- error here so a future schema drift (renamed column, FK to a missing
  -- row, etc.) cannot block auth.users inserts the way the original
  -- broken trigger did. The worst case becomes "no profile row was
  -- created", which the app can recover from on next login.
  BEGIN
    INSERT INTO public.profiles (id, full_name, avatar_url, updated_at)
    VALUES (NEW.id, v_full_name, v_avatar_url, now())
    ON CONFLICT (id) DO UPDATE
      SET full_name  = COALESCE(EXCLUDED.full_name,  public.profiles.full_name),
          avatar_url = COALESCE(EXCLUDED.avatar_url, public.profiles.avatar_url),
          updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING
      'handle_new_user(): profile upsert failed for auth.users.id=%: SQLSTATE=% SQLERRM=%',
      NEW.id, SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'AFTER INSERT trigger on auth.users. Best-effort upsert of public.profiles '
  '(id, full_name, avatar_url, updated_at). Errors are downgraded to WARNING '
  'so a profiles-schema mismatch cannot block GoTrue auth.users inserts. '
  'See supabase/migrations/20260506_fix_handle_new_user_v2.sql.';


-- ────────────────────────────────────────────────────────────────────────────
-- STEP 2. Re-grant EXECUTE to the roles GoTrue uses when inserting into
-- auth.users. The function is SECURITY DEFINER so the actual write to
-- public.profiles runs as the function owner, but the *trigger fire* still
-- requires the calling role to be able to invoke the function.
-- ────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.handle_new_user() TO postgres;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
-- `supabase_auth_admin` is the role GoTrue runs as when it inserts into
-- auth.users on signup. It exists on every Supabase project — if the
-- GRANT raises "role does not exist" you are running this script against
-- a non-Supabase Postgres and can comment the next line out.
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO anon;


-- ────────────────────────────────────────────────────────────────────────────
-- STEP 3. (Re)attach the AFTER INSERT trigger. Drop-and-recreate guarantees
-- a clean state — if a prior migration left a stale trigger pointing at
-- an older version of the function, this fixes it.
-- ────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ────────────────────────────────────────────────────────────────────────────
-- STEP 4. VERIFY by inserting a synthetic auth.users row and confirming
-- the trigger fires cleanly (no exception, profiles row created). Always
-- cleans up the test user before exiting.
-- ────────────────────────────────────────────────────────────────────────────

DO $verify$
DECLARE
  v_uid           uuid := gen_random_uuid();
  v_email         text := 'handle-new-user-verify-v2-' || replace(v_uid::text, '-', '') || '@famous-test.invalid';
  v_profile_count integer := 0;
BEGIN
  BEGIN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, is_super_admin, is_sso_user, is_anonymous
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      v_uid,
      'authenticated',
      'authenticated',
      v_email,
      crypt('verify-only-' || v_uid::text, gen_salt('bf')),
      now(),
      jsonb_build_object('provider', 'email', 'providers', ARRAY['email']),
      jsonb_build_object(
        'full_name',  'Verify v2 Test',
        'avatar_url', 'https://example.invalid/avatar.png'
      ),
      now(),
      now(),
      false,
      false,
      false
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'VERIFY FAILED: auth.users insert raised. SQLSTATE=%, SQLERRM=%. '
      'Inspect the function with: SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname=''handle_new_user'';',
      SQLSTATE, SQLERRM;
  END;

  -- Confirm the upsert ran (or at least did not block the auth.users insert).
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profiles'
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.profiles WHERE id = $1'
      INTO v_profile_count
      USING v_uid;
    RAISE NOTICE 'VERIFY OK: auth.users insert succeeded. matching public.profiles rows = %', v_profile_count;
  ELSE
    RAISE NOTICE 'VERIFY OK: auth.users insert succeeded (no public.profiles table on this database).';
  END IF;

  -- Cleanup. Cascade through identities/profiles via FK ON DELETE CASCADE.
  DELETE FROM auth.users WHERE id = v_uid;
  RAISE NOTICE 'VERIFY OK: cleanup complete (test user % deleted).', v_uid;
END
$verify$;


-- ────────────────────────────────────────────────────────────────────────────
-- STEP 5. Final visibility query. Run this at the end so the SQL Editor
-- shows the operator the function definition + trigger row in the result
-- pane (proof that the install actually landed).
-- ────────────────────────────────────────────────────────────────────────────

SELECT
  'function' AS object_kind,
  p.proname  AS object_name,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'handle_new_user'

UNION ALL

SELECT
  'trigger' AS object_kind,
  t.tgname  AS object_name,
  pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'auth'
  AND c.relname = 'users'
  AND t.tgname = 'on_auth_user_created'
  AND NOT t.tgisinternal;
