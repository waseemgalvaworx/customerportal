import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import {
  Loader2, CheckCircle2, AlertTriangle, RefreshCw, Play,
  ShieldCheck, Database, Link2, FileWarning, ExternalLink, Copy,
} from 'lucide-react';

// =============================================================================
// RolloutStatusPanel
// -----------------------------------------------------------------------------
// Live "are we ready for Step C (RLS enable)?" dashboard for the production
// rollout described in PRODUCTION_RLS_DEPLOYMENT.md. Surfaces the four numbers
// an operator actually cares about right after running the duplicate merge:
//
//   1. customers.total           — should match what was there before
//   2. customers.linked           — rows where userId IS NOT NULL
//   3. customers.unlinked         — rows where userId IS NULL (target: small)
//   4. _backfill_duplicates count — must be 0 before flipping RLS
//
// Provides one-click "Re-run auth backfill" (invokes the
// customer-auth-backfill edge function) and a built-in cross-tenant leak
// probe that the operator can run *after* enabling RLS to confirm the
// policies are actually scoping queries.
// =============================================================================

interface Counts {
  total: number;
  linked: number;
  unlinked: number;
  duplicates: number;
}

interface BackfillResult {
  processed?: number;
  linked?: number;
  skipped?: number;
  errors?: Array<{ customerId: string; reason: string }>;
  [k: string]: any;
}

const ROLLBACK_SQL = `-- ROLLBACK: restores pre-Step-C visibility (no data is touched)
alter table public.customers           disable row level security;
alter table public.jobs                disable row level security;
alter table public.quality_control     disable row level security;
alter table public.item_stage_tracking disable row level security;

drop policy if exists "customers_select_own"     on public.customers;
drop policy if exists "jobs_select_own_customer" on public.jobs;
drop policy if exists "qc_select_own_customer"   on public.quality_control;
drop policy if exists "ist_select_own_customer"  on public.item_stage_tracking;
drop function if exists public.current_customer_name();`;

const SQL_DASHBOARD =
  'https://supabase.com/dashboard/project/obtmrrbajlrdnmnfhcas/sql/new';
const FUNCTIONS_DASHBOARD =
  'https://supabase.com/dashboard/project/obtmrrbajlrdnmnfhcas/functions';

const RolloutStatusPanel: React.FC = () => {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  const [leakBusy, setLeakBusy] = useState(false);
  const [leakResult, setLeakResult] = useState<
    | { kind: 'pass'; rows: number }
    | { kind: 'fail'; rows: number; sample: any[] }
    | { kind: 'error'; message: string }
    | null
  >(null);

  // ---------- counts ----------
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // PostgREST count via head request — cheap, no row payload.
      const totalRes = await supabase
        .from('customers')
        .select('id', { count: 'exact', head: true });
      if (totalRes.error) throw totalRes.error;

      const linkedRes = await supabase
        .from('customers')
        .select('id', { count: 'exact', head: true })
        .not('userId', 'is', null);
      if (linkedRes.error) throw linkedRes.error;

      const unlinkedRes = await supabase
        .from('customers')
        .select('id', { count: 'exact', head: true })
        .is('userId', null);
      if (unlinkedRes.error) throw unlinkedRes.error;

      // _backfill_duplicates may be empty / table may not exist post-cleanup.
      let duplicates = 0;
      try {
        const dupRes = await supabase
          .from('_backfill_duplicates')
          .select('customer_id', { count: 'exact', head: true });
        if (!dupRes.error) duplicates = dupRes.count ?? 0;
      } catch {
        duplicates = 0;
      }

      setCounts({
        total: totalRes.count ?? 0,
        linked: linkedRes.count ?? 0,
        unlinked: unlinkedRes.count ?? 0,
        duplicates,
      });
    } catch (e: any) {
      setError(e?.message || 'Failed to load rollout status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ---------- backfill ----------
  const runBackfill = useCallback(async () => {
    setBackfillBusy(true);
    setBackfillError(null);
    setBackfillResult(null);
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke(
        'customer-auth-backfill',
        { body: {} },
      );
      if (invokeErr) throw new Error(invokeErr.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      setBackfillResult(data as BackfillResult);
      await refresh();
    } catch (e: any) {
      setBackfillError(e?.message || String(e));
    } finally {
      setBackfillBusy(false);
    }
  }, [refresh]);

  // ---------- leak probe ----------
  // Runs *as the currently signed-in admin*. After RLS is enabled with a
  // customer-scoped policy, an admin who is NOT linked to a customers row
  // should see 0 jobs rows by default. Before RLS, they'll see whatever the
  // service role / legacy policies allowed. The probe doesn't pass/fail
  // strictly — it shows the row count so the operator can interpret it.
  const runLeakProbe = useCallback(async () => {
    setLeakBusy(true);
    setLeakResult(null);
    try {
      const { data, error: probeErr } = await supabase
        .from('jobs')
        .select('id, customerName')
        .limit(5);
      if (probeErr) {
        setLeakResult({ kind: 'error', message: probeErr.message });
      } else if (!data || data.length === 0) {
        setLeakResult({ kind: 'pass', rows: 0 });
      } else {
        setLeakResult({ kind: 'fail', rows: data.length, sample: data });
      }
    } catch (e: any) {
      setLeakResult({ kind: 'error', message: e?.message || String(e) });
    } finally {
      setLeakBusy(false);
    }
  }, []);

  const copyRollback = () => {
    navigator.clipboard?.writeText(ROLLBACK_SQL).catch(() => {});
  };

  // ---------- gate: ready for Step C ----------
  const ready =
    !!counts &&
    counts.duplicates === 0 &&
    counts.total > 0 &&
    counts.linked >= Math.max(1, Math.floor(counts.total * 0.95));

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 bg-gradient-to-r from-[#1a1a4e] to-[#2a2a6e] text-white flex items-center gap-3">
        <ShieldCheck className="w-5 h-5" />
        <div className="flex-1 min-w-0">
          <h2 className="font-bold leading-tight">Production rollout status</h2>
          <p className="text-[11px] text-white/70 leading-tight">
            Step A → Step B → <strong>You are here</strong> → Step C (RLS) → Step D (verify)
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-white hover:bg-white/10"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="px-5 py-3 bg-red-50 border-b border-red-100 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      {/* counts grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-slate-100 border-b border-slate-100">
        <Stat
          icon={<Database className="w-4 h-4" />}
          label="Customers (total)"
          value={counts?.total}
          loading={loading}
          tone="neutral"
        />
        <Stat
          icon={<Link2 className="w-4 h-4" />}
          label="Linked to auth.users"
          value={counts?.linked}
          loading={loading}
          tone={
            !counts
              ? 'neutral'
              : counts.linked >= Math.floor(counts.total * 0.95)
              ? 'good'
              : 'warn'
          }
        />
        <Stat
          icon={<AlertTriangle className="w-4 h-4" />}
          label="Unlinked (userId NULL)"
          value={counts?.unlinked}
          loading={loading}
          tone={!counts ? 'neutral' : counts.unlinked === 0 ? 'good' : 'warn'}
        />
        <Stat
          icon={<FileWarning className="w-4 h-4" />}
          label="Backfill duplicates"
          value={counts?.duplicates}
          loading={loading}
          tone={!counts ? 'neutral' : counts.duplicates === 0 ? 'good' : 'bad'}
        />
      </div>

      {/* readiness banner */}
      <div
        className={`px-5 py-3 text-sm flex items-start gap-2 border-b ${
          ready
            ? 'bg-emerald-50 border-emerald-100 text-emerald-800'
            : 'bg-amber-50 border-amber-100 text-amber-800'
        }`}
      >
        {ready ? (
          <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
        ) : (
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        )}
        <div className="min-w-0">
          {ready ? (
            <>
              <strong>Ready for Step C.</strong> Duplicates are clean and{' '}
              {counts!.linked} of {counts!.total} customers are linked to auth.users.
              Proceed to enable RLS using the SQL file shown below.
            </>
          ) : (
            <>
              <strong>Not yet ready.</strong> Resolve any duplicates above and re-run
              the auth backfill until <code>linked ≈ total</code> and{' '}
              <code>duplicates = 0</code>.
            </>
          )}
        </div>
      </div>

      {/* actions */}
      <div className="p-5 space-y-5">
        {/* B: re-run backfill */}
        <Section
          step="B"
          title="Re-run auth backfill"
          desc="Invokes the customer-auth-backfill edge function. Idempotent — already-linked rows are skipped. Run this after every merge."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={runBackfill} disabled={backfillBusy} size="sm">
              {backfillBusy ? (
                <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Running…</>
              ) : (
                <><Play className="w-4 h-4 mr-1.5" /> Run backfill now</>
              )}
            </Button>
            <a
              href={FUNCTIONS_DASHBOARD}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-slate-500 hover:text-slate-800 inline-flex items-center gap-1"
            >
              View edge functions <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          {backfillError && (
            <div className="mt-2 bg-red-50 border border-red-200 rounded px-3 py-2 text-xs text-red-700">
              {backfillError}
              <div className="mt-1 text-red-600/80">
                If you see <em>"Function not found"</em>, deploy it first:&nbsp;
                <code className="font-mono">
                  supabase functions deploy customer-auth-backfill --no-verify-jwt
                </code>
              </div>
            </div>
          )}
          {backfillResult && (
            <div className="mt-2 bg-slate-900 text-slate-100 rounded px-3 py-2 text-xs font-mono whitespace-pre-wrap">
              {JSON.stringify(backfillResult, null, 2)}
            </div>
          )}
        </Section>

        {/* C: enable RLS */}
        <Section
          step="C"
          title="Enable Row-Level Security"
          desc="Open the SQL file below in your editor, copy its entire contents, paste into the Supabase SQL editor, and run."
        >
          <div className="space-y-2">
            <CodeRow
              label="SQL file"
              code="supabase/migrations/20260429_option_a_rls_enable.sql"
            />
            <a
              href={SQL_DASHBOARD}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-[#1a1a4e] hover:underline font-medium"
            >
              Open Supabase SQL editor <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <p className="text-xs text-slate-500">
              The file aborts if Step A wasn't applied, prints a NOTICE if any
              customers still have NULL <code>userId</code>, and installs one
              SELECT policy per table scoped to <code>auth.uid()</code>.
            </p>
          </div>
        </Section>

        {/* D: verify */}
        <Section
          step="D"
          title="Verify in the browser"
          desc="After Step C, run a cross-tenant leak probe from this page. The query below uses the live supabase client — it will return only rows your auth.uid() is allowed to see."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={runLeakProbe}
              disabled={leakBusy}
              size="sm"
              variant="outline"
            >
              {leakBusy ? (
                <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Probing…</>
              ) : (
                <><Play className="w-4 h-4 mr-1.5" /> Run leak probe</>
              )}
            </Button>
            <span className="text-xs text-slate-500">
              Selects up to 5 rows from <code>jobs</code> as the current user.
            </span>
          </div>
          {leakResult && (
            <div className="mt-2">
              {leakResult.kind === 'pass' && (
                <div className="bg-emerald-50 border border-emerald-200 rounded px-3 py-2 text-sm text-emerald-800 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  PASS — 0 rows returned. RLS (or service-role bypass absence) is scoping correctly for this account.
                </div>
              )}
              {leakResult.kind === 'fail' && (
                <div className="bg-amber-50 border border-amber-200 rounded px-3 py-2 text-sm text-amber-800">
                  <div className="flex items-center gap-2 font-medium">
                    <AlertTriangle className="w-4 h-4" />
                    {leakResult.rows} rows visible. Inspect — this is OK if you signed in
                    as a customer who owns those jobs, NOT OK if you're an admin
                    expecting RLS scoping.
                  </div>
                  <pre className="mt-2 text-[11px] font-mono bg-white/70 rounded p-2 overflow-auto max-h-40">
                    {JSON.stringify(leakResult.sample, null, 2)}
                  </pre>
                </div>
              )}
              {leakResult.kind === 'error' && (
                <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">
                  Probe error: {leakResult.message}
                </div>
              )}
            </div>
          )}
        </Section>

        {/* rollback */}
        <Section
          step="↩"
          title="Emergency rollback"
          desc="If Step C breaks something, paste this SQL into the dashboard. It disables RLS and drops the policies — no data is modified. Total rollback time is under a minute."
          tone="danger"
        >
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={copyRollback}>
              <Copy className="w-3.5 h-3.5 mr-1.5" /> Copy rollback SQL
            </Button>
            <a
              href={SQL_DASHBOARD}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-slate-500 hover:text-slate-800 inline-flex items-center gap-1"
            >
              Open SQL editor <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <pre className="mt-2 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded p-3 overflow-auto max-h-48">
            {ROLLBACK_SQL}
          </pre>
        </Section>
      </div>
    </div>
  );
};

// -----------------------------------------------------------------------------
// Sub-components.
// -----------------------------------------------------------------------------
const Stat: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  loading: boolean;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}> = ({ icon, label, value, loading, tone }) => {
  const toneClasses =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'warn'
      ? 'text-amber-700'
      : tone === 'bad'
      ? 'text-red-700'
      : 'text-slate-800';
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${toneClasses}`}>
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        ) : value === undefined ? (
          '—'
        ) : (
          value.toLocaleString()
        )}
      </div>
    </div>
  );
};

const Section: React.FC<{
  step: string;
  title: string;
  desc: string;
  tone?: 'normal' | 'danger';
  children: React.ReactNode;
}> = ({ step, title, desc, tone = 'normal', children }) => (
  <div
    className={`rounded-lg border p-4 ${
      tone === 'danger'
        ? 'border-red-100 bg-red-50/30'
        : 'border-slate-200 bg-slate-50/40'
    }`}
  >
    <div className="flex items-start gap-3">
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-full font-bold text-xs flex items-center justify-center ${
          tone === 'danger'
            ? 'bg-red-100 text-red-700'
            : 'bg-[#1a1a4e] text-white'
        }`}
      >
        {step}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-slate-900 text-sm">{title}</h3>
        <p className="text-xs text-slate-600 mt-0.5">{desc}</p>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  </div>
);

const CodeRow: React.FC<{ label: string; code: string }> = ({ label, code }) => (
  <div className="flex items-center gap-2 text-xs">
    <span className="text-slate-500 flex-shrink-0">{label}:</span>
    <code className="font-mono bg-slate-100 px-2 py-1 rounded text-slate-800 truncate">
      {code}
    </code>
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2"
      onClick={() => navigator.clipboard?.writeText(code).catch(() => {})}
    >
      <Copy className="w-3 h-3" />
    </Button>
  </div>
);

export default RolloutStatusPanel;
