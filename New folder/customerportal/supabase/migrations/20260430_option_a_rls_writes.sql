-- =============================================================================
-- OPTION A — WRITE POLICIES for the customer portal (companion to v2)
-- =============================================================================
-- Project:    obtmrrbajlrdnmnfhcas (the shared Galvabond backend)
-- Companion:  20260430_option_a_rls_enable_v2.sql  (must be deployed first)
-- File ID:    20260430_option_a_rls_writes.sql
--
-- WHY THIS FILE EXISTS
-- --------------------
-- v2 only granted SELECT to authenticated portal users. That is enough for the
-- *current* read-only portal, but as soon as we ship any write feature
-- (photo uploads, job feedback / sign-off, comments, attachments, etc.) the
-- write will silently fail under RLS — PostgREST returns a 403 / empty result
-- and the customer never sees their own change land.
--
-- This migration adds INSERT / UPDATE / DELETE policies that follow the SAME
-- ownership chain v2 uses for SELECT:
--
--     customers."userId" = auth.uid()
--         └── customers.id
--                 └── jobs."customerId"
--                         └── jobs.id
--                                 └── quality_control.job_id
--                                 └── item_stage_tracking.job_id
--                                 └── (future) job_photos.job_id
--                                 └── (future) job_feedback.job_id
--
-- DESIGN RULES (what is and isn't allowed from the portal)
-- --------------------------------------------------------
--   customers           : NO portal writes. Admin-managed only.
--                         (A user changing their own "userId" or email could
--                          re-link their auth identity to another customer
--                          row, so we never expose write to authenticated.)
--
--   jobs                : NO portal writes. Jobs are created by staff inside
--                         the operator app; the portal is read-only against
--                         them. If a future feature needs the customer to
--                         flip a single column (e.g. customer_signed_off),
--                         add a column-scoped UPDATE policy here, never a
--                         blanket UPDATE.
--
--   quality_control     : INSERT + UPDATE allowed for rows whose job_id
--                         resolves to the caller's customer.id. No DELETE
--                         (QC history is immutable from the portal side).
--
--   item_stage_tracking : INSERT + UPDATE allowed for rows whose job_id
--                         resolves to the caller's customer.id. No DELETE.
--
--   job_photos          : Template at the bottom — uncomment when the
--   job_feedback          underlying table is created. INSERT/SELECT/UPDATE/
--                         DELETE all scoped through jobs."customerId".
--
-- All policies use WITH CHECK in addition to USING, so a malicious client
-- can't INSERT a row pointing at someone else's job and can't UPDATE a row
-- to re-parent it onto another customer's job.
--
-- DEPLOY ORDER
-- ------------
--   1. 20260427_customers_user_id.sql
--   2. customer-auth-backfill edge function
--   3. 20260430_option_a_rls_enable_v2.sql        (SELECT policies + helpers)
--   4. THIS FILE                                   (write policies)
--
-- ROLLBACK is at the bottom.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Pre-flight checks — make sure v2 has already run.
-- -----------------------------------------------------------------------------
do $$
begin
  -- v2 must have created the helper.
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'current_customer_id'
  ) then
    raise exception
      'public.current_customer_id() is missing — deploy 20260430_option_a_rls_enable_v2.sql first.';
  end if;

  -- RLS must already be on (v2 enabled it). We don't re-enable here so this
  -- file is safely idempotent and won't toggle relrowsecurity if an operator
  -- has manually tuned it.
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'jobs'
      and c.relrowsecurity = true
  ) then
    raise exception
      'RLS is not enabled on public.jobs — deploy 20260430_option_a_rls_enable_v2.sql first.';
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 1. quality_control — allow INSERT / UPDATE on rows for the caller's jobs.
-- -----------------------------------------------------------------------------
-- Helper predicate used by every quality_control write policy:
--   the row's job_id must belong to a job whose "customerId" is the caller's
--   customer.id.
--
-- We resolve the caller's customer.id once via current_customer_id() (the
-- SECURITY DEFINER helper from v2) so the policy doesn't recurse through the
-- customers table's own RLS.

drop policy if exists "qc_insert_own_customer" on public.quality_control;
create policy "qc_insert_own_customer"
  on public.quality_control
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.jobs j
      where j.id           = public.quality_control.job_id
        and j."customerId" = public.current_customer_id()
    )
  );

drop policy if exists "qc_update_own_customer" on public.quality_control;
create policy "qc_update_own_customer"
  on public.quality_control
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.jobs j
      where j.id           = public.quality_control.job_id
        and j."customerId" = public.current_customer_id()
    )
  )
  with check (
    -- Block re-parenting an existing QC row onto someone else's job.
    exists (
      select 1
      from public.jobs j
      where j.id           = public.quality_control.job_id
        and j."customerId" = public.current_customer_id()
    )
  );

-- Intentionally NO DELETE policy on quality_control — QC history is
-- append-only from the portal side. (Operator app uses service role.)


-- -----------------------------------------------------------------------------
-- 2. item_stage_tracking — allow INSERT / UPDATE on rows for the caller's jobs.
-- -----------------------------------------------------------------------------
drop policy if exists "ist_insert_own_customer" on public.item_stage_tracking;
create policy "ist_insert_own_customer"
  on public.item_stage_tracking
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.jobs j
      where j.id           = public.item_stage_tracking.job_id
        and j."customerId" = public.current_customer_id()
    )
  );

drop policy if exists "ist_update_own_customer" on public.item_stage_tracking;
create policy "ist_update_own_customer"
  on public.item_stage_tracking
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.jobs j
      where j.id           = public.item_stage_tracking.job_id
        and j."customerId" = public.current_customer_id()
    )
  )
  with check (
    exists (
      select 1
      from public.jobs j
      where j.id           = public.item_stage_tracking.job_id
        and j."customerId" = public.current_customer_id()
    )
  );

-- Intentionally NO DELETE policy on item_stage_tracking — stage history is
-- append-only from the portal side.


-- -----------------------------------------------------------------------------
-- 3. customers / jobs — explicitly NO portal writes.
-- -----------------------------------------------------------------------------
-- We are deliberately not creating INSERT/UPDATE/DELETE policies on these.
-- Without a permissive policy, RLS denies the action by default for the
-- authenticated role, which is exactly what we want:
--
--   * customers — only the operator app (service role) creates / edits these.
--   * jobs       — same.
--
-- If a future feature needs (e.g.) the customer to flip a single
-- `customer_signed_off boolean` column on jobs, add a column-scoped policy
-- here following the same EXISTS pattern, e.g.:
--
--   create policy "jobs_update_signoff_own_customer"
--     on public.jobs
--     for update
--     to authenticated
--     using       ( "customerId" = public.current_customer_id() )
--     with check  ( "customerId" = public.current_customer_id() );
--
--   -- and pair it with a column-level GRANT so only that column is writable:
--   revoke update on public.jobs from authenticated;
--   grant  update (customer_signed_off) on public.jobs to authenticated;


-- =============================================================================
-- 4. TEMPLATE — future portal-write tables (job_photos, job_feedback)
-- =============================================================================
-- The portal does not yet have a `job_photos` or `job_feedback` table, but
-- when those tables are added (each with a `job_id uuid references jobs(id)`
-- column) the policies below should be deployed alongside them. They follow
-- the exact same scoping chain so behaviour stays consistent across tables.
--
-- DO NOT uncomment until the corresponding table actually exists, otherwise
-- the migration will fail with "relation does not exist".
--
-- ----------------------------- job_photos -----------------------------------
--
-- alter table public.job_photos enable row level security;
--
-- drop policy if exists "job_photos_select_own_customer" on public.job_photos;
-- create policy "job_photos_select_own_customer"
--   on public.job_photos
--   for select
--   to authenticated
--   using (
--     exists (
--       select 1
--       from public.jobs j
--       where j.id           = public.job_photos.job_id
--         and j."customerId" = public.current_customer_id()
--     )
--   );
--
-- drop policy if exists "job_photos_insert_own_customer" on public.job_photos;
-- create policy "job_photos_insert_own_customer"
--   on public.job_photos
--   for insert
--   to authenticated
--   with check (
--     exists (
--       select 1
--       from public.jobs j
--       where j.id           = public.job_photos.job_id
--         and j."customerId" = public.current_customer_id()
--     )
--   );
--
-- drop policy if exists "job_photos_update_own_customer" on public.job_photos;
-- create policy "job_photos_update_own_customer"
--   on public.job_photos
--   for update
--   to authenticated
--   using (
--     exists (
--       select 1
--       from public.jobs j
--       where j.id           = public.job_photos.job_id
--         and j."customerId" = public.current_customer_id()
--     )
--   )
--   with check (
--     exists (
--       select 1
--       from public.jobs j
--       where j.id           = public.job_photos.job_id
--         and j."customerId" = public.current_customer_id()
--     )
--   );
--
-- drop policy if exists "job_photos_delete_own_customer" on public.job_photos;
-- create policy "job_photos_delete_own_customer"
--   on public.job_photos
--   for delete
--   to authenticated
--   using (
--     exists (
--       select 1
--       from public.jobs j
--       where j.id           = public.job_photos.job_id
--         and j."customerId" = public.current_customer_id()
--     )
--   );
--
-- ----------------------------- job_feedback ---------------------------------
--
-- alter table public.job_feedback enable row level security;
--
-- drop policy if exists "job_feedback_select_own_customer" on public.job_feedback;
-- create policy "job_feedback_select_own_customer"
--   on public.job_feedback for select to authenticated
--   using (
--     exists (
--       select 1 from public.jobs j
--       where j.id = public.job_feedback.job_id
--         and j."customerId" = public.current_customer_id()
--     )
--   );
--
-- drop policy if exists "job_feedback_insert_own_customer" on public.job_feedback;
-- create policy "job_feedback_insert_own_customer"
--   on public.job_feedback for insert to authenticated
--   with check (
--     exists (
--       select 1 from public.jobs j
--       where j.id = public.job_feedback.job_id
--         and j."customerId" = public.current_customer_id()
--     )
--   );
--
-- drop policy if exists "job_feedback_update_own_customer" on public.job_feedback;
-- create policy "job_feedback_update_own_customer"
--   on public.job_feedback for update to authenticated
--   using (
--     exists (
--       select 1 from public.jobs j
--       where j.id = public.job_feedback.job_id
--         and j."customerId" = public.current_customer_id()
--     )
--   )
--   with check (
--     exists (
--       select 1 from public.jobs j
--       where j.id = public.job_feedback.job_id
--         and j."customerId" = public.current_customer_id()
--     )
--   );
--
-- drop policy if exists "job_feedback_delete_own_customer" on public.job_feedback;
-- create policy "job_feedback_delete_own_customer"
--   on public.job_feedback for delete to authenticated
--   using (
--     exists (
--       select 1 from public.jobs j
--       where j.id = public.job_feedback.job_id
--         and j."customerId" = public.current_customer_id()
--     )
--   );
--
-- ----------------------------- Storage RLS ----------------------------------
-- If photos are uploaded to a Supabase Storage bucket (e.g. `job-photos`) the
-- same chain has to be re-implemented as a storage.objects policy, e.g.:
--
--   create policy "job_photos_object_own_customer"
--     on storage.objects for all to authenticated
--     using (
--       bucket_id = 'job-photos'
--       and exists (
--         select 1 from public.jobs j
--         where j.id::text = (storage.foldername(name))[1]      -- /<job_id>/<file>
--           and j."customerId" = public.current_customer_id()
--       )
--     )
--     with check (
--       bucket_id = 'job-photos'
--       and exists (
--         select 1 from public.jobs j
--         where j.id::text = (storage.foldername(name))[1]
--           and j."customerId" = public.current_customer_id()
--       )
--     );
-- =============================================================================


-- =============================================================================
-- VERIFICATION
-- =============================================================================
-- Run from the SQL editor (service role bypasses RLS, so these always succeed):
--
-- 1) All write policies exist:
--      select schemaname, tablename, policyname, cmd
--      from pg_policies
--      where schemaname = 'public'
--        and tablename in ('quality_control','item_stage_tracking')
--      order by tablename, cmd;
--    Expected: SELECT (from v2) + INSERT + UPDATE on each, no DELETE.
--
-- 2) From the browser as a signed-in portal user, against one of YOUR own jobs:
--      // Replace <yourJobId> with a job_id you actually own.
--      const { data, error } = await supabase
--        .from('quality_control')
--        .insert({ job_id: '<yourJobId>', /* …other required cols… */ })
--        .select();
--      console.log({ data, error });   // expect a row back, no 42501 / RLS error
--
-- 3) Cross-tenant write block (replace with someone ELSE's job_id):
--      const { data, error } = await supabase
--        .from('quality_control')
--        .insert({ job_id: '<otherCustomersJobId>' })
--        .select();
--      console.log({ data, error });   // expect error.code === '42501' (RLS)
--
-- 4) Re-parent attempt — try to UPDATE one of your QC rows to point at
--    someone else's job_id. The WITH CHECK clause should reject it:
--      const { error } = await supabase
--        .from('quality_control')
--        .update({ job_id: '<otherCustomersJobId>' })
--        .eq('id', '<yourQcRowId>');
--      console.log(error);             // expect '42501'
-- =============================================================================


-- =============================================================================
-- ROLLBACK (paste back into the SQL editor if you need to undo this file only;
-- v2's SELECT policies stay intact)
-- =============================================================================
-- drop policy if exists "qc_insert_own_customer"   on public.quality_control;
-- drop policy if exists "qc_update_own_customer"   on public.quality_control;
-- drop policy if exists "ist_insert_own_customer"  on public.item_stage_tracking;
-- drop policy if exists "ist_update_own_customer"  on public.item_stage_tracking;
-- =============================================================================
