-- ════════════════════════════════════════════════════════════════════════════
-- FIX BROKEN handle_new_user() TRIGGER ON auth.users
--
-- BACKGROUND
--   The legacy public.handle_new_user() AFTER-INSERT trigger on auth.users
--   tries to write to public.profiles columns that do not exist on this
--   project's schema:
--
--     INSERT INTO public.profiles (id, email, full_name)
--     VALUES (new.id, new.email, new.raw_user_meta_data->>'full_name')
--
--   Specifically, public.profiles.email is missing, so EVERY new auth.users
--   insert (signups, admin invites, the customer-auth backfill, etc.) fails
--   with:
--
--     ERROR: 42703: column "email" of relation "profiles" does not exist
--
--   This script inspects the actual public.profiles schema on THIS database
--   and rewrites handle_new_user() to only insert into columns that really
--   exist. It also wraps the body in EXCEPTION WHEN OTHERS so a future schema
--   drift NEVER blocks user creation again.
--
--   It is safe to re-run (CREATE OR REPLACE).
--
-- HOW TO RUN
--   Open the Supabase SQL Editor for project obtmrrbajlrdnmnfhcas, paste this
--   entire file, and Run. Watch the "Messages" tab for RAISE NOTICE output —
--   the script reports which columns it detected, what insert statement it
--   built, and the result of the test insert at the end.
--
-- DESIGN CHOICE: option (b) — fix the function, do NOT add a profiles.email
--   column. The customer portal app does not read or write public.profiles
--   anywhere (verified by codebase search), so adding columns purely to
--   satisfy a legacy trigger would be cargo-culted dead schema. If you want
--   option (a) instead — add the missing column — see the OPTION A block at
--   the very bottom of this file (commented out).
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- STEP 1. Detect whether public.profiles exists at all, and which of the
-- candidate columns are present. We support these candidates because they
-- are the columns the original trigger and common Supabase starter templates
-- reference:
--
--   id          uuid    -- always required, links to auth.users.id
--   email       text
--   full_name   text
--   name        text
--   avatar_url  text
--   created_at  timestamptz
--   updated_at  timestamptz
-- ────────────────────────────────────────────────────────────────────────────

DO $fix$
DECLARE
  v_profiles_exists boolean;
  v_has_id          boolean;
  v_has_email       boolean;
  v_has_full_name   boolean;
  v_has_name        boolean;
  v_has_avatar_url  boolean;
  v_has_created_at  boolean;
  v_has_updated_at  boolean;
  v_cols            text := '';
  v_vals            text := '';
  v_body            text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profiles'
  ) INTO v_profiles_exists;

  IF NOT v_profiles_exists THEN
    RAISE NOTICE
      'public.profiles does NOT exist on this database. Installing a no-op handle_new_user() so auth.users inserts cannot be blocked.';

    EXECUTE $no_op$
      CREATE OR REPLACE FUNCTION public.handle_new_user()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $body$
      BEGIN
        -- public.profiles does not exist on this database; nothing to do.
        RETURN NEW;
      END;
      $body$;
    $no_op$;

    RETURN;
  END IF;

  -- Detect each candidate column.
  SELECT
    bool_or(column_name = 'id'),
    bool_or(column_name = 'email'),
    bool_or(column_name = 'full_name'),
    bool_or(column_name = 'name'),
    bool_or(column_name = 'avatar_url'),
    bool_or(column_name = 'created_at'),
    bool_or(column_name = 'updated_at')
  INTO
    v_has_id,
    v_has_email,
    v_has_full_name,
    v_has_name,
    v_has_avatar_url,
    v_has_created_at,
    v_has_updated_at
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'profiles';

  RAISE NOTICE
    'public.profiles columns detected — id=%, email=%, full_name=%, name=%, avatar_url=%, created_at=%, updated_at=%',
    v_has_id, v_has_email, v_has_full_name, v_has_name, v_has_avatar_url,
    v_has_created_at, v_has_updated_at;

  IF NOT COALESCE(v_has_id, false) THEN
    RAISE EXCEPTION
      'public.profiles is missing the required "id" column. Cannot link rows to auth.users — please add: ALTER TABLE public.profiles ADD COLUMN id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE;';
  END IF;

  -- Build the column list and the matching VALUES list. We always insert id;
  -- everything else is conditional on actually existing on the table.
  v_cols := 'id';
  v_vals := 'NEW.id';

  IF v_has_email THEN
    v_cols := v_cols || ', email';
    v_vals := v_vals || ', NEW.email';
  END IF;

  IF v_has_full_name THEN
    v_cols := v_cols || ', full_name';
    v_vals := v_vals || ', NEW.raw_user_meta_data->>''full_name''';
  END IF;

  IF v_has_name THEN
    -- Some schemas use "name" instead of "full_name". Populate from full_name
    -- metadata first, then fall back to name metadata.
    v_cols := v_cols || ', name';
    v_vals := v_vals || ', COALESCE(NEW.raw_user_meta_data->>''full_name'', NEW.raw_user_meta_data->>''name'')';
  END IF;

  IF v_has_avatar_url THEN
    v_cols := v_cols || ', avatar_url';
    v_vals := v_vals || ', NEW.raw_user_meta_data->>''avatar_url''';
  END IF;

  IF v_has_created_at THEN
    v_cols := v_cols || ', created_at';
    v_vals := v_vals || ', now()';
  END IF;

  IF v_has_updated_at THEN
    v_cols := v_cols || ', updated_at';
    v_vals := v_vals || ', now()';
  END IF;

  v_body := format($func$
    CREATE OR REPLACE FUNCTION public.handle_new_user()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $body$
    BEGIN
      BEGIN
        INSERT INTO public.profiles (%s)
        VALUES (%s)
        ON CONFLICT (id) DO NOTHING;
      EXCEPTION WHEN OTHERS THEN
        -- Never block auth.users insert. Profile rows are best-effort.
        RAISE WARNING 'handle_new_user(): profile insert failed for %%: %% / %%',
          NEW.id, SQLSTATE, SQLERRM;
      END;
      RETURN NEW;
    END;
    $body$;
  $func$, v_cols, v_vals);

  RAISE NOTICE 'Installing handle_new_user() with INSERT INTO public.profiles (%) VALUES (%)', v_cols, v_vals;

  EXECUTE v_body;
END
$fix$;

-- ────────────────────────────────────────────────────────────────────────────
-- STEP 2. Make sure the trigger is actually wired up to auth.users. If a
-- prior migration dropped it, recreate it. If it already exists with the
-- canonical name, leave it alone.
-- ────────────────────────────────────────────────────────────────────────────

DO $wire$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth'
      AND c.relname = 'users'
      AND t.tgname = 'on_auth_user_created'
      AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
    RAISE NOTICE 'Created trigger on_auth_user_created on auth.users.';
  ELSE
    RAISE NOTICE 'Trigger on_auth_user_created already exists; left in place.';
  END IF;
END
$wire$;

-- ────────────────────────────────────────────────────────────────────────────
-- STEP 3. VERIFY by inserting a synthetic auth.users row inside a savepoint.
-- If the trigger is still broken, the INSERT will raise. Either way the
-- temporary user is rolled back at the end so we don't leave test data
-- behind.
-- ────────────────────────────────────────────────────────────────────────────

DO $verify$
DECLARE
  v_uid       uuid := gen_random_uuid();
  v_email     text := 'handle-new-user-verify-' || replace(v_uid::text, '-', '') || '@famous-test.invalid';
  v_profile_count int;
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
      jsonb_build_object('provider','email','providers',ARRAY['email']),
      jsonb_build_object('full_name','Verify Test','name','Verify Test'),
      now(),
      now(),
      false,
      false,
      false
    );

    -- If a profiles table exists, confirm the row was created (or, at worst,
    -- not created but no exception was raised — both outcomes prove the
    -- trigger is no longer blocking auth.users inserts).
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'profiles'
    ) THEN
      EXECUTE 'SELECT count(*) FROM public.profiles WHERE id = $1'
        INTO v_profile_count
        USING v_uid;
      RAISE NOTICE 'VERIFY: auth.users insert succeeded; matching public.profiles rows = %', v_profile_count;
    ELSE
      RAISE NOTICE 'VERIFY: auth.users insert succeeded (no public.profiles table on this DB).';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'VERIFY FAILED: auth.users insert still raises. SQLSTATE=%, SQLERRM=%. Inspect handle_new_user() with: SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname=''handle_new_user'';',
      SQLSTATE, SQLERRM;
  END;

  -- Clean up the test rows. Cascade through identities/profiles via FKs.
  DELETE FROM auth.users WHERE id = v_uid;
  RAISE NOTICE 'VERIFY: cleanup complete (test user deleted).';
END
$verify$;

-- ════════════════════════════════════════════════════════════════════════════
-- OPTION A (alternate fix) — ADD the missing email + full_name columns to
-- public.profiles instead of patching the trigger. Uncomment and run only if
-- you actually want public.profiles to mirror auth.users.email. Most projects
-- do NOT need this; option (b) above is preferred.
-- ════════════════════════════════════════════════════════════════════════════
--
-- ALTER TABLE public.profiles
--   ADD COLUMN IF NOT EXISTS email      text,
--   ADD COLUMN IF NOT EXISTS full_name  text,
--   ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
--   ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
--
-- CREATE INDEX IF NOT EXISTS profiles_email_idx ON public.profiles (lower(email));
--
-- -- Backfill profiles from auth.users for existing accounts:
-- INSERT INTO public.profiles (id, email, full_name)
-- SELECT u.id, u.email, u.raw_user_meta_data->>'full_name'
-- FROM auth.users u
-- ON CONFLICT (id) DO UPDATE
--   SET email     = EXCLUDED.email,
--       full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name);
--
-- After running OPTION A, you may still want to run STEP 1 above so the
-- trigger picks up the now-existing email + full_name columns dynamically.
