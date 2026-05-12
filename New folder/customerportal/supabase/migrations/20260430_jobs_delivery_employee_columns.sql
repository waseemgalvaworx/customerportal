-- =============================================================================
-- 20260430_jobs_delivery_employee_columns.sql
-- =============================================================================
-- DOCUMENTATION-ONLY MIGRATION.
--
-- The customer portal surfaces three additional pieces of information on a
-- job that are NOT separate columns in the data model:
--
--   1. Tentative Delivery
--      Source: jobs.production_finishing_date (timestamptz)
--      Already exists in production via the earlier migration
--      `add_production_finishing_date.sql`. The Job Management system
--      already writes this column when ops sets a finishing date during
--      Planning.
--      → No DDL needed here.
--
--   2. Delivered date
--      Source: jobs.delivered_at (timestamptz)
--      Already exists in production. It pre-dates the formal migrations
--      directory (was added to the live database manually / in an
--      un-named migration), and is referenced throughout the Job
--      Management codebase (e.g. app/done.tsx, app/archive.tsx,
--      components/JobDeliveredCheckbox.tsx). For documentation +
--      idempotent re-runs we re-declare it with IF NOT EXISTS so this
--      file can also be used to bring fresh / staging environments up
--      to date.
--
--   3. Brought-by / customer-contact name
--      Source: PARSED FROM jobs.notes by src/lib/extractContactName.ts
--      No new column is required. Operators already type the name into
--      notes ("Brought by: John Doe" / "Contact: John" / etc.) and the
--      portal pulls it out at render time.
--      → No DDL needed.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION ACTUALLY EXECUTES
-- ---------------------------------------------------------------------------
-- A defensive `add column if not exists` for `delivered_at` plus a
-- supporting partial index, so a freshly-cloned environment ends up
-- with the same shape as production. On the live data project these
-- statements are no-ops because the column + index already exist.
-- =============================================================================

-- 1. delivered_at — timestamp ops sets when a job is marked
--    shipped/delivered. Already present in production.
alter table public.jobs
  add column if not exists delivered_at timestamptz;

-- 2. Partial index — keeps the History tab's date-range queries fast
--    without bloating active-job lookups.
create index if not exists idx_jobs_delivered_at
  on public.jobs (delivered_at)
  where delivered_at is not null;

-- 3. Self-documenting metadata.
comment on column public.jobs.delivered_at is
  'Actual physical delivery / shipment timestamp. Populated when ops marks the job shipped/delivered. Surfaced on the customer portal as "Delivered".';

-- 4. (For reference only — the customer portal also reads
--     production_finishing_date for the "Tentative Delivery" line.
--     That column is created by add_production_finishing_date.sql.)
comment on column public.jobs.production_finishing_date is
  'Tentative delivery date set during the Planning stage. Surfaced on the customer portal as "Tentative Delivery".';
