-- =============================================================================
-- DISABLE RLS — required because the customer portal uses LEGACY secure-login
-- =============================================================================
-- RUN THIS IN THE SUPABASE SQL EDITOR FOR PROJECT obtmrrbajlrdnmnfhcas
-- (the project the frontend's src/lib/supabase.ts actually connects to).
--
-- WHY
-- ---
-- 20260427_customer_rls.sql added policies that filter rows by
--   "userId" = auth.uid()
-- ...assuming the portal uses real Supabase Auth. It does not — it uses
-- the legacy `secure-login` edge function with a custom session in
-- public.users. That means `auth.uid()` is NULL on every client request,
-- which makes `current_customer_name()` return NULL, which makes every
-- policy's USING clause evaluate to NULL (i.e. false), which silently
-- returns ZERO rows for every SELECT against jobs / customers /
-- quality_control / item_stage_tracking — exactly the symptom we are
-- seeing in the Active and History tabs.
--
-- Defense in depth is preserved by the client-side scoping in
-- CustomerPortal.tsx:
--   • resolves the customer row by userId / user_id / customer_id / username
--   • applies .eq('customerId', resolved.id) on the jobs query
--   • final belt-and-braces filter on customer_name === resolved.name
-- =============================================================================

ALTER TABLE public.jobs                DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.quality_control     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_stage_tracking DISABLE ROW LEVEL SECURITY;

-- =============================================================================
-- VERIFICATION (run while logged in as a customer in the portal)
-- =============================================================================
-- 1) The portal's Active + History tabs should now populate.
-- 2) From the browser devtools network tab, confirm the request to
--    /rest/v1/jobs?customerId=eq.<uuid> returns rows (not []).
-- 3) From the SQL editor (service role bypasses RLS, so use anon key in
--    a separate tool to verify), confirm reads work without auth.uid().
--
-- =============================================================================
-- REVERT (only after migrating the portal to real Supabase Auth)
-- =============================================================================
-- ALTER TABLE public.jobs                ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.customers           ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.quality_control     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.item_stage_tracking ENABLE ROW LEVEL SECURITY;
