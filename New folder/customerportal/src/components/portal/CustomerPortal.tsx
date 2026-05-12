import React, { useEffect, useMemo, useRef, useState, useCallback, lazy, Suspense } from 'react';

import { supabase } from '@/lib/supabase';

import { usePasswordAuth } from '@/contexts/PasswordAuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Search, LogOut, Briefcase, Clock, Loader2,
  ChevronDown, ChevronUp, Calendar as CalendarIcon, TrendingUp, X,
} from 'lucide-react';
import JobCard, { type Job } from './JobCard';
import VirtualizedJobList from './VirtualizedJobList';


// Code-split the (heavy) job details view so it isn't part of the
// initial portal bundle. The user only pays the download cost when
// they actually click into a job for the first time.
const CustomerJobDetailsView = lazy(() => import('./CustomerJobDetailsModal'));

import HistoryDateRangePicker from './HistoryDateRangePicker';
import { normalizeRows } from '@/lib/normalize';

import type { DateRange } from 'react-day-picker';
const LOGO_URL = 'https://d64gsuwffb70l.cloudfront.net/6826def9056908ac6c0eb35d_1777283619714_a14cfc88.jpg';


// =============================================================================
// ACTIVE / HISTORY CLASSIFICATION RULES
// =============================================================================
//
// Per business spec (rev. May 2026 — eliminate the "limbo" period):
//
//   ACTIVE   =  status ≠ 'archived'  AND  delivered_at IS NULL
//   HISTORY  =  ( status = 'archived'  OR  delivered_at IS NOT NULL )
//                AND  dateOfEntry >= 2026-01-01
//
// A job leaves Active and enters History the INSTANT it is checked
// delivered (i.e. `delivered_at` is set) — it no longer has to wait
// for the nightly auto-archive cron to flip status='archived'. This
// removes the previous several-minutes-to-hours window during which a
// freshly-delivered job was invisible in both tabs. Auto-archived jobs
// that were never delivered (rare, but possible) are still included in
// History via the status='archived' branch of the OR.
//
// Tab membership is decided BY THE DATABASE: each tab has its own
// scoped query and we keep an in-memory cache per tab so flipping
// between them is instant. This eliminates the previous "fetch 2000
// rows + filter client-side" pattern, which silently truncated
// customers with hundreds of archived jobs.
// =============================================================================



// Cutoff: do NOT show history jobs whose dateOfEntry is older than this.
const HISTORY_CUTOFF_ISO = '2026-01-01';
const HISTORY_CUTOFF_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

// Per-query row cap. Each scoped query is now narrow enough that a single
// customer is extremely unlikely to exceed this — but we keep an explicit
// ceiling so a runaway query can never blow up the browser tab.
const SCOPED_QUERY_LIMIT = 5000;

// Returns true when a value looks like a real, non-empty timestamp /
// non-zero date string. We treat empty strings, 0, "0", and the unix
// epoch ("1970-01-01...") as "not set" because some upstream writers
// initialize the columns to those sentinels rather than NULL.
const hasRealTimestamp = (v: any): boolean => {
  if (v === null || v === undefined) return false;
  if (v === 0 || v === '0') return false;
  const s = String(v).trim();
  if (!s) return false;
  if (s.startsWith('1970-01-01')) return false;
  const t = new Date(s).getTime();
  return Number.isFinite(t) && t > 0;
};

// Resolve the various camelCase/snake_case spellings of `delivered_at`.
const getDeliveredAt = (job: Job): string | null => {
  const j = job as any;
  return (
    j.delivered_at ??
    j.deliveredAt ??
    j.delivered_date ??
    j.deliveredDate ??
    null
  );
};

// Resolve the various spellings of `dateOfEntry` — the canonical date
// the job was logged into the system. Fall back to created_at if the
// row predates the dateOfEntry column.
const getDateOfEntry = (job: Job): string | null => {
  const j = job as any;
  return (
    j.dateOfEntry ??
    j.date_of_entry ??
    j.created_at ??
    j.createdAt ??
    null
  );
};

const isArchivedStatus = (s: string | null | undefined): boolean =>
  String(s ?? '').toLowerCase().trim() === 'archived';

// Returns the timestamp we use to bucket a history job into a month.
// Per spec we group by dateOfEntry (the system-of-record date for the
// job's lifecycle), falling back to delivered_at then updated_at if
// dateOfEntry is somehow missing.
const historyJobTimestamp = (j: Job): number => {
  const ref =
    getDateOfEntry(j) ||
    getDeliveredAt(j) ||
    j.updated_at ||
    j.created_at;
  if (!ref) return 0;
  const t = new Date(ref).getTime();
  return Number.isFinite(t) ? t : 0;
};

// All dates in this portal are formatted in the Mauritius timezone (GMT+4).
const PORTAL_TIMEZONE = 'Indian/Mauritius';

const mauritiusYearMonth = (d: Date): { year: number; month: number } => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PORTAL_TIMEZONE,
    year: 'numeric', month: '2-digit',
  }).formatToParts(d);
  const year = Number(parts.find((p) => p.type === 'year')?.value || 0);
  const month = Number(parts.find((p) => p.type === 'month')?.value || 1) - 1;
  return { year, month };
};

const monthKey = (d?: string | null) => {
  if (!d) return 'Unknown';
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString('en-GB', {
      timeZone: PORTAL_TIMEZONE,
      year: 'numeric', month: 'long',
    });
  } catch { return 'Unknown'; }
};

const monthSortKey = (d?: string | null) => {
  if (!d) return 0;
  try {
    const { year, month } = mauritiusYearMonth(new Date(d));
    return year * 100 + month;
  } catch { return 0; }
};

const currentMauritiusMonthKey = (): string => monthKey(new Date().toISOString());

// Total weight resolution mirrors JobCard.
const getItemsWeight = (items: any[] | undefined | null): number => {
  if (!items || !Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    const w = parseFloat(String(item?.weightKg ?? '0'));
    return sum + (isFinite(w) ? w : 0);
  }, 0);
};

const getJobWeight = (j: Job): number => {
  const direct = (j as any).total_weight ?? (j as any).weight;
  const n = Number(direct);
  if (direct != null && isFinite(n) && n > 0) return n;
  return getItemsWeight((j as any).items);
};

const formatPortalDate = (d?: string | null): string => {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-GB', {
      timeZone: PORTAL_TIMEZONE,
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return '—'; }
};

// Roles that should be scoped to a single customer's data.
const CUSTOMER_SCOPED_ROLES = new Set(['customer', 'customer_portal']);
const isCustomerScoped = (user: any): boolean => {
  if (!user) return false;
  if (CUSTOMER_SCOPED_ROLES.has(user.role)) return true;
  const a = user.permissions?.allowedScreens;
  if (Array.isArray(a) && a.length === 1 && a.includes('customer-portal')) return true;
  return false;
};

// =============================================================================
// DATA SOURCE SELECTION (RLS-aware)
// =============================================================================
//
// Customers can land in this portal under one of two auth paths:
//
//   A) Supabase Auth (`authenticated_via_supabase_auth === true`)
//      auth.uid() is populated on every PostgREST request, so the new
//      restrictive RLS policies (`customers."userId" = auth.uid()`,
//      jobs scoped via the customers join, etc.) all pass. We can read
//      directly from the `customers` and `jobs` tables via supabase-js.
//
//   B) Legacy `secure-login` (`authenticated_via_supabase_auth === false`)
//      There is NO Supabase Auth session, so auth.uid() is null. The
//      `20260427_disable_rls_legacy_auth.sql` migration disables RLS on
//      `jobs` and `customers` for the anon role specifically so legacy
//      sessions can still read their own data via direct PostgREST queries.
//
// HISTORY: an earlier version of this file routed legacy users through a
// `customer-jobs` edge function that ran under the service role to
// bypass RLS. That function is NOT deployed to this project's Supabase
// instance (`obtmrrbajlrdnmnfhcas`) — confirmed May 2026 — and trying
// to invoke it surfaces "Failed to send a request to the Edge Function"
// in the browser. Since RLS is already disabled for legacy users, we
// don't actually need the edge function: direct table reads work for
// both auth paths. We therefore force `shouldUseEdgeFunction()` to
// `false` permanently. The edge-function code path below is kept only
// as a fallback that is never triggered, in case a future deploy of
// `customer-jobs` makes it useful again.
// =============================================================================
const shouldUseEdgeFunction = (_u: any): boolean => {
  // Edge function `customer-jobs` is not deployed; always use direct
  // table reads (RLS is off for the anon role on legacy auth, and on
  // for Supabase Auth users — both work with direct reads).
  return false;
};


// Split a flat list of jobs into the same Active / History buckets the
// per-tab direct queries would have produced. Used for the edge-function
// path, which returns ALL of a customer's jobs in one payload.
//
// Per the May 2026 spec, History now includes any job whose
// `delivered_at` is set OR whose status is 'archived' — so a job
// transitions out of Active the moment it's checked delivered, even
// before the nightly auto-archive runs.
const splitJobsByTab = (rows: Job[]): { active: Job[]; history: Job[] } => {
  const active: Job[] = [];
  const history: Job[] = [];
  for (const j of rows) {
    const archived = isArchivedStatus((j as any).status);
    const deliveredAt = getDeliveredAt(j);
    const isDelivered = hasRealTimestamp(deliveredAt);
    if (!archived && !isDelivered) {
      active.push(j);
      continue;
    }
    if (archived || isDelivered) {
      const ts = historyJobTimestamp(j);
      if (ts >= HISTORY_CUTOFF_MS) history.push(j);
    }
  }
  return { active, history };
};


// Columns we project from `jobs`. We explicitly select `items` because
// some PostgREST configurations omit large jsonb columns from `*`.
const SELECT_COLS = '*, items, customers(name)';

// Apply a final defensive client-side scoping filter. Any row whose
// linkage doesn't match the resolved customer is dropped — this is
// belt-and-braces against an RLS misconfiguration.
const applyClientScope = (
  rows: any[],
  resolved: { id: string; name: string },
): Job[] => {
  const mapped: Job[] = normalizeRows(rows).map((j: any) => ({
    ...j,
    customer_name: j.customers?.name || j.customer_name || resolved.name,
  }));
  const normName = (s: any) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
  const wantName = normName(resolved.name);
  return mapped.filter((j: any) => {
    const jn = normName(j.customer_name ?? j.customerName ?? null);
    const jc = j.customer_id ?? j.customerId ?? null;
    return jn === wantName || jc === resolved.id;
  });
};


const CustomerPortal: React.FC = () => {
  const { user, logout } = usePasswordAuth();
  const { subscribe, reconnect } = useRealtime();

  // Per-tab data caches. Each tab has its own state slice so switching
  // between Active and History is instant after the first load.
  const [activeJobs, setActiveJobs] = useState<Job[]>([]);
  const [historyJobs, setHistoryJobs] = useState<Job[]>([]);


  // Per-tab loaded flags so a "no jobs found" empty state isn't shown
  // before the first fetch resolves.
  const [activeLoaded, setActiveLoaded] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const [loadingActive, setLoadingActive] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [dateMode, setDateMode] = useState<'all' | 'custom'>('all');
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [collapsedMonths, setCollapsedMonths] = useState<Record<string, boolean>>({});

  // On-screen debug log.
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showDebug, setShowDebug] = useState<boolean>(false);
  const dbg = useCallback((msg: string, data?: any) => {
    const line = data !== undefined
      ? `${new Date().toLocaleTimeString()}  ${msg}  ${JSON.stringify(data)}`
      : `${new Date().toLocaleTimeString()}  ${msg}`;
    setDebugLog((prev) => [...prev.slice(-49), line]);
  }, []);

  // Customer record resolved client-side from the `customers` table.
  const [customerRecord, setCustomerRecord] = useState<{ id: string; name: string } | null>(null);

  // Track whether we've already attempted the one-shot
  // `customer-auth-backfill` self-heal so the portal doesn't
  // re-invoke it on every realtime refetch / tab switch.
  const backfillAttemptedRef = useRef<boolean>(false);

  // Resolve the `customers` row for the logged-in user. Runs once per
  // session — the result is reused by every scoped jobs query below.
  //
  // The portal supports six escalating linkage strategies, each one
  // logged via dbg() so the operator can see exactly what was tried
  // when a user lands on the "not linked" error screen:
  //
  //   1. customers.userId   = user.id    (post-backfill, exact)
  //   2. customers.user_id  = user.id    (snake_case variant)
  //   3. customers.id       = user.customer_id  (denormalized link)
  //   4. customers.name     ILIKE user.username (exact, ignores case)
  //   5. customers.name     ILIKE %user.username% (forward fuzzy — only
  //                                                accepts a unique hit)
  //   6. user.username contains customers.name   (reverse fuzzy — only
  //                                                accepts a unique hit;
  //                                                covers e.g. user
  //                                                "GS Steel" → customer
  //                                                "GS Steel Fabrication
  //                                                LLC" as documented in
  //                                                portal_backfill
  //                                                diagnostics)
  //
  // IMPORTANT: when an authenticated user has not yet been linked to a
  // `customers` row, the RLS policy `customers."userId" = auth.uid()`
  // blocks ALL of these reads — even the fuzzy ones — because there's
  // no row whose userId matches their auth.uid() yet. In that case
  // every strategy silently returns 0 rows (no error, no data) and we
  // end up at the "FAILED — no linkage found" log. The auto-heal in
  // the calling effect (`runResolveAndMaybeBackfill`) detects that
  // outcome and invokes the `customer-auth-backfill` edge function,
  // which runs under the service role to set `customers.userId` for
  // any matching row — at which point a retry of resolveCustomer
  // succeeds via strategy #1.
  const resolveCustomer = useCallback(async (): Promise<{ id: string; name: string } | null> => {
    if (!user) return null;
    if (!isCustomerScoped(user)) {
      dbg('REFUSING: user is not customer-scoped', { role: user.role });
      return null;
    }

    dbg('resolveCustomer start', {
      id: user.id,
      username: user.username,
      customer_id: (user as any).customer_id ?? (user as any).customerId ?? null,
    });

    const candidates: Array<{ column: string; value: string }> = [];
    if (user.id) {
      candidates.push({ column: 'userId', value: user.id });
      candidates.push({ column: 'user_id', value: user.id });
    }
    const cid = (user as any).customer_id ?? (user as any).customerId ?? null;
    if (cid) candidates.push({ column: 'id', value: cid });

    for (const c of candidates) {
      const { data, error: lookupErr } = await supabase
        .from('customers')
        .select('id, name')
        .eq(c.column, c.value)
        .limit(1)
        .maybeSingle();
      if (lookupErr) {
        dbg(`customer lookup by ${c.column} ERROR`, { msg: lookupErr.message });
        continue;
      }
      if (data) {
        dbg(`customer resolved via ${c.column}`, data);
        return data as any;
      }
    }

    const uname = (user.username || '').trim();
    if (uname) {
      // 4. Exact case-insensitive match.
      {
        const { data, error: lookupErr } = await supabase
          .from('customers')
          .select('id, name')
          .ilike('name', uname)
          .limit(1)
          .maybeSingle();
        if (!lookupErr && data) {
          dbg('customer resolved via username->name(ilike exact)', data);
          return data as any;
        }
        if (lookupErr) {
          dbg('customer lookup by name(ilike exact) ERROR', { msg: lookupErr.message });
        }
      }

      // 5. Forward fuzzy.
      {
        const esc = uname.replace(/[%_]/g, (ch) => `\\${ch}`);
        const { data, error: lookupErr } = await supabase
          .from('customers')
          .select('id, name')
          .ilike('name', `%${esc}%`)
          .limit(2);
        if (!lookupErr && data && data.length === 1) {
          dbg('customer resolved via fuzzy name contains username', data[0]);
          return data[0] as any;
        }
        if (!lookupErr && data && data.length > 1) {
          dbg('fuzzy name match AMBIGUOUS — refusing to guess', {
            count: data.length,
            samples: data.map((d: any) => d.name),
          });
        }
        if (lookupErr) {
          dbg('customer lookup by fuzzy name(ilike) ERROR', { msg: lookupErr.message });
        }
      }

      // 6. Reverse fuzzy.
      {
        const { data, error: lookupErr } = await supabase
          .from('customers')
          .select('id, name')
          .limit(500);
        if (!lookupErr && data) {
          dbg('reverse fuzzy candidate scan', { scanned: data.length });
          const lc = uname.toLowerCase();
          const hits = (data as any[]).filter((c) => {
            const n = String(c?.name ?? '').trim().toLowerCase();
            return n.length >= 3 && lc.includes(n);
          });
          if (hits.length === 1) {
            dbg('customer resolved via reverse fuzzy (username contains name)', hits[0]);
            return hits[0] as any;
          }
          if (hits.length > 1) {
            dbg('reverse fuzzy AMBIGUOUS — refusing to guess', {
              count: hits.length,
              samples: hits.slice(0, 5).map((h: any) => h.name),
            });
          }
        }
        if (lookupErr) {
          dbg('reverse fuzzy lookup ERROR', { msg: lookupErr.message });
        }
      }
    }

    dbg('resolveCustomer FAILED — no linkage found');
    return null;
  }, [user, dbg]);

  // -------------------------------------------------------------------------
  // Auto-heal: if resolveCustomer comes back empty for an authenticated
  // user, invoke `customer-auth-backfill` (which runs under the service
  // role on the project's Supabase instance, so it can both READ the
  // unlinked customer rows that RLS hides from us and WRITE the
  // `customers.userId` link) and then retry the resolution exactly once.
  //
  // We gate this on backfillAttemptedRef so a stuck case (e.g. a
  // username that genuinely doesn't match any customer name) doesn't
  // hammer the backfill function on every refresh.
  // -------------------------------------------------------------------------
  const runResolveAndMaybeBackfill = useCallback(async (): Promise<{ id: string; name: string } | null> => {
    let resolved = await resolveCustomer();
    if (resolved) return resolved;
    if (backfillAttemptedRef.current) return null;
    backfillAttemptedRef.current = true;
    dbg('attempting customer-auth-backfill self-heal');
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke(
        'customer-auth-backfill',
        { body: {} },
      );
      if (invokeErr) {
        dbg('customer-auth-backfill invoke error', { msg: invokeErr.message });
      } else {
        dbg('customer-auth-backfill done', {
          processed: (data as any)?.processed,
          linked: (data as any)?.linked,
          skipped: (data as any)?.skipped,
        });
      }
    } catch (e: any) {
      dbg('customer-auth-backfill threw', { msg: e?.message });
    }
    // Retry resolution once after the backfill — strategy #1 should
    // now hit since the backfill set customers.userId where it could.
    resolved = await resolveCustomer();
    if (resolved) {
      dbg('resolveCustomer succeeded after backfill retry', resolved);
    } else {
      dbg('resolveCustomer still empty after backfill retry');
    }
    return resolved;
  }, [resolveCustomer, dbg]);




  // Run a scoped jobs query under both linkage strategies (customerName
  // ilike + customerId eq), merge by id, and apply the client-side scope
  // filter. `applyFilters` lets the caller layer additional `.eq` /
  // `.is` / `.gte` predicates on top so each tab's query is narrow.
  const runScopedJobsQuery = useCallback(async (
    resolved: { id: string; name: string },
    applyFilters: (q: any) => any,
    label: string,
  ): Promise<Job[]> => {
    const byId = new Map<string, any>();
    const merge = (arr: any[] | null | undefined) => {
      for (const r of arr ?? []) {
        if (r && r.id != null) byId.set(String(r.id), r);
      }
    };

    const trimmedName = (resolved.name || '').trim();

    // Primary: name-based linkage.
    let q1 = supabase
      .from('jobs')
      .select(SELECT_COLS)
      .ilike('customerName', trimmedName);
    q1 = applyFilters(q1);
    const r1 = await q1
      .order('updatedAt', { ascending: false })
      .limit(SCOPED_QUERY_LIMIT);
    dbg(`[${label}] by customerName(ilike)`, {
      err: r1.error?.message,
      count: r1.data?.length ?? 0,
    });
    if (!r1.error) merge(r1.data);

    // Secondary: uuid FK linkage.
    let q2 = supabase
      .from('jobs')
      .select(SELECT_COLS)
      .eq('customerId', resolved.id);
    q2 = applyFilters(q2);
    const r2 = await q2.limit(SCOPED_QUERY_LIMIT);
    dbg(`[${label}] by customerId(uuid)`, {
      err: r2.error?.message,
      count: r2.data?.length ?? 0,
    });
    if (!r2.error) merge(r2.data);

    return applyClientScope(Array.from(byId.values()), resolved);
  }, [dbg]);

  // Active tab fetch:
  //   status ≠ 'archived'  AND  delivered_at IS NULL
  const loadActive = useCallback(async (resolved: { id: string; name: string }) => {
    setLoadingActive(true);
    try {
      const activeRows = await runScopedJobsQuery(
        resolved,
        (q) => q.neq('status', 'archived').is('delivered_at', null),
        'active',
      );
      setActiveJobs(activeRows);
      setActiveLoaded(true);
      dbg('loadActive done', { active: activeRows.length });
    } catch (e: any) {
      dbg('loadActive FAILED', { msg: e?.message });
      setError(e?.message || 'Failed to load active jobs');
    } finally {
      setLoadingActive(false);
      setRefreshing(false);
    }
  }, [runScopedJobsQuery, dbg]);

  // History tab fetch:
  //   ( status = 'archived'  OR  delivered_at IS NOT NULL )
  //   AND  dateOfEntry >= 2026-01-01
  //
  // The OR is expressed as a single PostgREST `.or()` filter so it
  // becomes a server-side predicate and we don't have to fetch+drop
  // rows client-side. PostgREST `.or()` syntax for "is not null" is
  // `delivered_at.not.is.null`. Both branches share the dateOfEntry
  // cutoff via `.gte()` (applied after the OR so it ANDs together).
  const loadHistory = useCallback(async (resolved: { id: string; name: string }) => {
    setLoadingHistory(true);
    try {
      const rows = await runScopedJobsQuery(
        resolved,
        (q) => q
          .or('status.eq.archived,delivered_at.not.is.null')
          .gte('dateOfEntry', HISTORY_CUTOFF_ISO),
        'history',
      );
      setHistoryJobs(rows);
      setHistoryLoaded(true);
      dbg('loadHistory done', { count: rows.length });
    } catch (e: any) {
      dbg('loadHistory FAILED', { msg: e?.message });
      setError(e?.message || 'Failed to load history');
    } finally {
      setLoadingHistory(false);
      setRefreshing(false);
    }
  }, [runScopedJobsQuery, dbg]);

  // ---------------------------------------------------------------------------
  // Edge-function path (legacy `secure-login` users — no auth.uid()).
  // ---------------------------------------------------------------------------
  // The `customer-jobs` edge function takes the AuthUser payload, resolves
  // the linked customer server-side under the service role, and returns
  // the customer record + a pre-filtered list of every job belonging to
  // that customer in one shot.
  //
  // IMPORTANT (May 2026): the `customer-jobs` edge function is not always
  // deployed to the project's own Supabase instance (`obtmrrbajlrdnmnfhcas`)
  // — that's a manual deploy step documented in
  // `supabase/migrations/20260427_customer_jobs_DEPLOY_README.md`. When it
  // hasn't been deployed there, `supabase.functions.invoke('customer-jobs')`
  // raises `FunctionsFetchError: Failed to send a request to the Edge
  // Function` (which is exactly the error the operator was seeing).
  //
  // Rather than leave the portal broken until that deploy happens, we now
  // FALL BACK to a fully client-side data path whenever the edge function
  // is unreachable: resolve the customer via the same lookup the function
  // uses, then run the per-tab scoped queries (`loadActive` / `loadHistory`)
  // directly against the `jobs` table. The fallback works for legacy
  // secure-login users iff:
  //
  //   * RLS is OFF on `jobs` and `customers` for the anon role, OR
  //   * The customer's auth has been migrated to Supabase Auth and RLS is on
  //
  // When RLS *is* on AND the user is on the legacy path, the fallback will
  // simply return zero rows and the user will see the standard
  // "no customer profile linked" / "no jobs" empty states — no worse than
  // the previous "Failed to send a request" hard error.
  // ---------------------------------------------------------------------------
  const loadJobsViaEdgeFunction = useCallback(async (
    authUser: any,
  ): Promise<{ customer: { id: string; name: string } | null; loaded: boolean }> => {
    setLoadingActive(true);
    setLoadingHistory(true);

    // Helper: run the client-side fallback (used when the edge function
    // is unreachable or returns a structured error). Returns the resolved
    // customer (or null) and ensures both caches + the loaded flags are
    // populated so the UI exits its loading state.
    const runClientSideFallback = async (): Promise<{ customer: { id: string; name: string } | null; loaded: boolean }> => {
      dbg('edge unreachable — falling back to client-side scoped queries');
      try {
        const resolved = await resolveCustomer();
        if (!resolved) {
          setError('Your account is not linked to a customer profile. Please contact your account manager.');
          setActiveJobs([]); setHistoryJobs([]);
          setActiveLoaded(true); setHistoryLoaded(true);
          return { customer: null, loaded: false };
        }
        // Clear any earlier "edge function unreachable" error since we
        // recovered. If the queries below fail they'll set their own.
        setError(null);
        // Run both tabs' queries in parallel so the user sees data fast.
        const [activeRows, historyRows] = await Promise.all([
          runScopedJobsQuery(
            resolved,
            (q) => q.neq('status', 'archived').is('delivered_at', null),
            'active(fallback)',
          ).catch((e: any) => {
            dbg('fallback active query FAILED', { msg: e?.message });
            return [] as Job[];
          }),
          runScopedJobsQuery(
            resolved,
            (q) => q
              .or('status.eq.archived,delivered_at.not.is.null')
              .gte('dateOfEntry', HISTORY_CUTOFF_ISO),
            'history(fallback)',
          ).catch((e: any) => {
            dbg('fallback history query FAILED', { msg: e?.message });
            return [] as Job[];
          }),
        ]);

        setActiveJobs(activeRows);
        setHistoryJobs(historyRows);
        setActiveLoaded(true);
        setHistoryLoaded(true);
        dbg('client-side fallback done', {
          customer: resolved.name,
          active: activeRows.length,
          history: historyRows.length,
        });
        return { customer: resolved, loaded: true };
      } catch (e: any) {
        dbg('client-side fallback threw', { msg: e?.message });
        setError(e?.message || 'Failed to load jobs');
        setActiveJobs([]); setHistoryJobs([]);
        setActiveLoaded(true); setHistoryLoaded(true);
        return { customer: null, loaded: false };
      }
    };

    try {
      const payload = {
        user: {
          id: authUser.id,
          username: authUser.username,
          role: authUser.role,
          customer_id: authUser.customer_id ?? authUser.customerId ?? null,
          customerId: authUser.customer_id ?? authUser.customerId ?? null,
        },
      };

      const { data, error: fnError } = await supabase.functions.invoke(
        'customer-jobs',
        { body: payload },
      );

      if (fnError) {
        // Distinguish between:
        //  (a) the function being UNREACHABLE (not deployed, CORS, network)
        //      → fall back to client-side queries.
        //  (b) the function being reachable but returning a structured
        //      error body (e.g. "no linked customer" 404) → surface that
        //      message to the user verbatim.
        let errBody: any = null;
        try {
          const ctx = (fnError as any)?.context;
          if (ctx && typeof ctx.text === 'function') {
            const txt = await ctx.text();
            try { errBody = JSON.parse(txt); } catch { errBody = { error: txt }; }
          } else if (ctx && ctx.body) {
            errBody = ctx.body;
          }
        } catch { /* ignore */ }

        const errName = String((fnError as any)?.name || '');
        const errMsg = String((fnError as any)?.message || '');
        const isUnreachable =
          errName === 'FunctionsFetchError'
          || /failed to (send|fetch)/i.test(errMsg)
          || /network|load failed/i.test(errMsg)
          || (!errBody && !((fnError as any)?.context?.status));

        if (isUnreachable) {
          dbg('edge customer-jobs UNREACHABLE — using fallback', {
            name: errName,
            msg: errMsg,
          });
          return await runClientSideFallback();
        }

        // Reachable but errored — show the server's message.
        const msg = errBody?.error
          || errMsg
          || 'Could not load your jobs. Please try again or contact your account manager.';
        dbg('edge customer-jobs error', { msg, name: errName });
        setError(msg);
        setActiveJobs([]); setHistoryJobs([]);
        setActiveLoaded(true); setHistoryLoaded(true);
        return { customer: null, loaded: false };
      }

      const body: any = data;

      if (!body || body.error || !body.customer) {
        const msg = body?.error || 'Your account is not linked to a customer profile. Please contact your account manager.';
        dbg('edge customer-jobs no-customer', { msg });
        setError(msg);
        setActiveJobs([]); setHistoryJobs([]);
        setActiveLoaded(true); setHistoryLoaded(true);
        return { customer: null, loaded: false };
      }

      const resolved = body.customer as { id: string; name: string };
      const rawJobs = (body.jobs ?? []) as any[];
      const normalized = applyClientScope(rawJobs, resolved);
      const { active, history } = splitJobsByTab(normalized);
      setActiveJobs(active);
      setHistoryJobs(history);
      setActiveLoaded(true);
      setHistoryLoaded(true);
      dbg('edge customer-jobs done', {
        customer: resolved.name,
        raw: rawJobs.length,
        active: active.length,
        history: history.length,
      });
      return { customer: resolved, loaded: true };
    } catch (e: any) {
      // invoke() can THROW (rather than return { error }) on full network
      // failure (DNS, offline, blocked by extension/CSP) or when the
      // function isn't deployed. Treat any throw as "unreachable" and
      // fall through to the client-side fallback rather than showing the
      // user a dead-end "Network error" page.
      dbg('edge customer-jobs threw — using fallback', { msg: e?.message, name: e?.name });
      return await runClientSideFallback();
    } finally {
      setLoadingActive(false);
      setLoadingHistory(false);
      setRefreshing(false);
    }
  }, [dbg, resolveCustomer, runScopedJobsQuery]);





  // Initial mount: pick the data source based on the user's auth path,
  // resolve the customer, then prime the cache(s).
  //
  //   - Supabase Auth users  → resolve via direct `customers` query, then
  //                            load the visible tab; the other tab loads
  //                            lazily on first switch.
  //   - Legacy secure-login  → fetch EVERYTHING through `customer-jobs`
  //                            edge function in one round-trip; both
  //                            tabs are populated immediately.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) return;
      setError(null);
      const scoped = isCustomerScoped(user);
      if (!scoped) {
        setActiveJobs([]); setHistoryJobs([]);
        setCustomerRecord(null);
        setLoadingActive(false);
        setActiveLoaded(true);
        return;
      }

      // ---- Legacy auth path: edge function (RLS-bypassing) ----
      if (shouldUseEdgeFunction(user)) {
        dbg('using edge function (legacy secure-login session)');
        const { customer } = await loadJobsViaEdgeFunction(user);
        if (cancelled) return;
        setCustomerRecord(customer);
        return;
      }

      // ---- Supabase Auth path: direct table reads (RLS-protected) ----
      // We go through `runResolveAndMaybeBackfill` rather than plain
      // `resolveCustomer` so that an unlinked auth user automatically
      // triggers a one-shot `customer-auth-backfill` self-heal before
      // we give up. This handles the brand-new-Supabase-Auth case where
      // the customers row exists but its `userId` column is still NULL,
      // which RLS then hides from every direct-read strategy.
      dbg('using direct table reads (Supabase Auth session)');
      const resolved = await runResolveAndMaybeBackfill();
      if (cancelled) return;
      if (!resolved) {
        setCustomerRecord(null);
        setActiveJobs([]); setHistoryJobs([]);
        setError('Your account is not linked to a customer profile. Please contact your account manager.');
        setLoadingActive(false);
        setActiveLoaded(true);
        return;
      }

      setCustomerRecord(resolved);
      // Always load the visible tab first.
      if (tab === 'active') {
        await loadActive(resolved);
      } else {
        await loadHistory(resolved);
      }
    })();
    return () => { cancelled = true; };
    // We only want this to fire on user change; tab transitions are
    // handled by the dedicated effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Lazy-load the History tab the first time the user switches to it.
  // Skipped entirely on the edge-function path because that path
  // populates BOTH caches in a single round-trip on initial mount.
  useEffect(() => {
    if (!customerRecord) return;
    if (shouldUseEdgeFunction(user)) return;
    if (tab === 'history' && !historyLoaded && !loadingHistory) {
      loadHistory(customerRecord);
    }
    if (tab === 'active' && !activeLoaded && !loadingActive) {
      loadActive(customerRecord);
    }
  }, [tab, customerRecord, historyLoaded, activeLoaded, loadingHistory, loadingActive, loadHistory, loadActive, user]);


  // Realtime: re-invoke the scoped fetch on jobs changes. We debounce
  // routine edits, but transitions that move a job between Active and
  // History trigger an immediate refetch of BOTH sides of the divide so
  // both caches stay coherent. On the edge-function path every refetch
  // re-pulls the entire customer payload, which already populates both
  // tabs together.
  useEffect(() => {
    if (!user || !isCustomerScoped(user) || !customerRecord) return;

    const useEdge = shouldUseEdgeFunction(user);

    let debounceTimer: any;
    const refetchVisibleSoon = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (useEdge) {
          loadJobsViaEdgeFunction(user);
        } else if (tab === 'active') {
          loadActive(customerRecord);
        } else {
          loadHistory(customerRecord);
        }
      }, 600);
    };
    const refetchBothNow = () => {
      clearTimeout(debounceTimer);
      if (useEdge) {
        loadJobsViaEdgeFunction(user);
        return;
      }
      // Refetch the visible tab immediately; mark the other as dirty so
      // it reloads on next switch.
      if (tab === 'active') {
        loadActive(customerRecord);
        setHistoryLoaded(false);
      } else {
        loadHistory(customerRecord);
        setActiveLoaded(false);
      }
    };

    const rowDeliveredAt = (row: any): any => {
      if (!row) return null;
      return (
        row.delivered_at ??
        row.deliveredAt ??
        row.delivered_date ??
        row.deliveredDate ??
        null
      );
    };

    const justGotDeliveredAt = (payload: any): boolean => {
      const newRow = payload?.new ?? null;
      const oldRow = payload?.old ?? null;
      if (!newRow) return false;
      const newD = rowDeliveredAt(newRow);
      const oldD = rowDeliveredAt(oldRow);
      return hasRealTimestamp(newD) && !hasRealTimestamp(oldD);
    };

    const justArchived = (payload: any): boolean => {
      const newRow = payload?.new ?? null;
      const oldRow = payload?.old ?? null;
      if (!newRow) return false;
      if (!isArchivedStatus(newRow.status)) return false;
      if (!oldRow) return true;
      return !isArchivedStatus(oldRow.status);
    };

    const handleJobsChange = (payload: any) => {
      if (justGotDeliveredAt(payload) || justArchived(payload)) {
        dbg('realtime: tab transition — refetching now', {
          jobId: payload?.new?.id,
          newStatus: payload?.new?.status,
        });
        refetchBothNow();
        return;
      }
      refetchVisibleSoon();
    };

    const u1 = subscribe('jobs', handleJobsChange);
    const u2 = subscribe('quality_control', refetchVisibleSoon);
    const u3 = subscribe('item_stage_tracking', refetchVisibleSoon);
    return () => {
      clearTimeout(debounceTimer);
      u1(); u2(); u3();
    };
  }, [subscribe, user, customerRecord, tab, loadActive, loadHistory, loadJobsViaEdgeFunction, dbg]);

  const handleRefresh = () => {
    if (!customerRecord) return;
    setRefreshing(true);
    reconnect();
    if (shouldUseEdgeFunction(user)) {
      loadJobsViaEdgeFunction(user);
      return;
    }
    if (tab === 'active') {
      loadActive(customerRecord);
      setHistoryLoaded(false);
    } else {
      loadHistory(customerRecord);
      setActiveLoaded(false);
    }
  };


  // Counts come straight from the cached arrays — these now hold ONLY
  // the rows that already match each tab's predicates (the database has
  // already done the filtering).
  const counts = useMemo(() => ({
    active: activeJobs.length,
    history: historyJobs.length,
  }), [activeJobs, historyJobs]);


  // Search filter applied per tab. The cached arrays are already
  // tab-correct so we only have to layer the search + (history) date
  // range on top.
  const filteredActive = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeJobs;
    return activeJobs.filter((j) => {
      const hay = [j.job_number, j.title, j.description, j.customer_name, j.status]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [activeJobs, search]);

  const filteredHistory = useMemo(() => {
    const q = search.trim().toLowerCase();
    return historyJobs.filter((j) => {
      if (dateMode === 'custom' && dateRange?.from) {
        const ts = historyJobTimestamp(j);
        const from = dateRange.from.getTime();
        const to = dateRange.to ? dateRange.to.getTime() + 24 * 60 * 60 * 1000 - 1 : Date.now();
        if (ts < from || ts > to) return false;
      }
      if (q) {
        const hay = [j.job_number, j.title, j.description, j.customer_name, j.status]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [historyJobs, search, dateMode, dateRange]);

  // History grouped by month (by dateOfEntry).
  const historyByMonth = useMemo(() => {
    if (tab !== 'history') return [] as { month: string; sortKey: number; jobs: Job[]; totalWeight: number }[];
    const groups: Record<string, { jobs: Job[]; sortKey: number; totalWeight: number }> = {};
    for (const j of filteredHistory) {
      const ts = historyJobTimestamp(j);
      const ref = ts > 0 ? new Date(ts).toISOString() : (j.updated_at || j.created_at);
      const k = monthKey(ref);
      if (!groups[k]) groups[k] = { jobs: [], sortKey: monthSortKey(ref), totalWeight: 0 };
      groups[k].jobs.push(j);
      groups[k].totalWeight += getJobWeight(j);
    }
    return Object.entries(groups)
      .map(([month, g]) => ({ month, ...g }))
      .sort((a, b) => b.sortKey - a.sortKey);
  }, [filteredHistory, tab]);

  const historySummary = useMemo(() => {
    const jobsCount = filteredHistory.length;
    let items = 0;
    let totalKg = 0;
    let earliest: number | null = null;
    for (const j of filteredHistory) {
      const directItems = Number(j.total_items ?? 0);
      const fallbackItems = Array.isArray((j as any).items) ? (j as any).items.length : 0;
      items += directItems > 0 ? directItems : fallbackItems;
      totalKg += getJobWeight(j);
      const ts = historyJobTimestamp(j);
      if (ts > 0 && (earliest === null || ts < earliest)) earliest = ts;
    }
    let earliestLabel = '';
    if (earliest !== null) {
      // Floor to the spec cutoff so the label never reads "Dec 2025".
      const t = Math.max(earliest, HISTORY_CUTOFF_MS);
      earliestLabel = new Date(t).toLocaleDateString('en-GB', {
        timeZone: PORTAL_TIMEZONE,
        month: 'short', year: 'numeric',
      });
    }
    return { jobsCount, items, totalKg, earliestLabel, monthCount: historyByMonth.length };
  }, [filteredHistory, historyByMonth]);

  // Default-collapse months we haven't seen yet (current month expanded).
  const initializedMonthsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (historyByMonth.length === 0) return;
    const currentKey = currentMauritiusMonthKey();
    setCollapsedMonths((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const g of historyByMonth) {
        if (initializedMonthsRef.current.has(g.month)) continue;
        initializedMonthsRef.current.add(g.month);
        const shouldCollapse = g.month !== currentKey;
        if (next[g.month] !== shouldCollapse) {
          next[g.month] = shouldCollapse;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [historyByMonth]);

  const toggleMonth = (m: string) =>
    setCollapsedMonths((prev) => ({ ...prev, [m]: !prev[m] }));

  const expandAll = () => setCollapsedMonths({});
  const collapseAll = () => {
    const all: Record<string, boolean> = {};
    for (const g of historyByMonth) all[g.month] = true;
    setCollapsedMonths(all);
  };

  const customerName = customerRecord?.name || (user as any)?.customer_name || user?.full_name || user?.username || 'Customer';

  // Inline details view — replaces the list when a job is selected.
  if (selectedJob) {
    return (
      <Suspense fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-100 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      }>
        <CustomerJobDetailsView
          job={selectedJob}
          onBack={() => setSelectedJob(null)}
        />
      </Suspense>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      {/* Header */}
      <header className="bg-[#1a1a4e] text-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-lg bg-[#1a1a4e] ring-1 ring-white/20 flex items-center justify-center flex-shrink-0 overflow-hidden">
              <img src={LOGO_URL} alt="Galvabond" className="w-full h-full object-contain" />
            </div>
            <div className="min-w-0">
              <h1 className="font-extrabold text-lg leading-tight tracking-wider truncate">GALVABOND</h1>
              <p className="text-[11px] text-white/70 truncate">Customer Portal</p>
            </div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
          >
            <LogOut className="w-4 h-4 text-white" />
          </button>
        </div>
      </header>

      {/* Customer name bar */}
      <div className="bg-slate-100 border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 text-center">
          <p className="font-bold text-slate-900 text-sm">{customerName}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2">
            <button
              type="button"
              onClick={() => setTab('active')}
              className={`flex items-center justify-center gap-2 py-4 text-sm font-semibold transition-all border-2
                ${tab === 'active'
                  ? 'bg-[#eeeaff] border-[#1a1a4e]/20 text-[#1a1a4e]'
                  : 'bg-white border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              <Briefcase className="w-4 h-4" />
              <span>Active Jobs</span>
              <span className="ml-1 inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-[#1a1a4e] text-white text-[11px] font-bold">
                {counts.active}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setTab('history')}
              className={`flex items-center justify-center gap-2 py-4 text-sm font-semibold transition-all border-2
                ${tab === 'history'
                  ? 'bg-[#eeeaff] border-[#1a1a4e]/20 text-[#1a1a4e]'
                  : 'bg-white border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              <Clock className="w-4 h-4" />
              <span>History</span>
              {tab === 'history' && counts.history > 0 && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-[#1a1a4e] text-white text-[11px] font-bold">
                  {counts.history}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5">
        {error && (
          <div className="text-sm bg-red-50 text-red-700 border border-red-200 rounded-md px-3 py-2 mb-4">
            <div>{error}</div>
            {/* Diagnostic context — included in the error block so the
                operator can copy-paste it into a support ticket without
                having to dig through the on-screen debug log. */}
            <div className="mt-1 text-[11px] text-red-600/80 break-all">
              <span className="font-mono">
                user.id={user?.id ?? '—'} | username={user?.username ?? '—'} | customer_id={(user as any)?.customer_id ?? (user as any)?.customerId ?? '—'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowDebug((v) => !v)}
              className="mt-2 text-[11px] underline text-red-700 hover:text-red-900"
            >
              {showDebug ? 'Hide' : 'Show'} debug log
            </button>
            {showDebug && (
              <pre className="mt-2 max-h-64 overflow-auto bg-white/60 border border-red-200 rounded p-2 text-[11px] text-slate-700 whitespace-pre-wrap">
                {debugLog.length === 0 ? 'no log entries yet' : debugLog.join('\n')}
              </pre>
            )}
          </div>
        )}


        {tab === 'active' ? (
          <ActiveJobsView
            jobs={filteredActive}
            loading={loadingActive && !activeLoaded}
            onSelect={setSelectedJob}
          />

        ) : (
          <HistoryView
            search={search}
            onSearchChange={setSearch}
            dateMode={dateMode}
            onDateModeChange={(m) => {
              setDateMode(m);
              if (m === 'all') setDateRange(undefined);
            }}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
            summary={historySummary}
            historyByMonth={historyByMonth}
            collapsedMonths={collapsedMonths}
            onToggleMonth={toggleMonth}
            onExpandAll={expandAll}
            onCollapseAll={collapseAll}
            onSelect={setSelectedJob}
            loading={loadingHistory && !historyLoaded}
          />
        )}
      </main>
    </div>
  );
};

/* ----------- Active Jobs View ----------- */

const ActiveJobsView: React.FC<{
  jobs: Job[];
  loading: boolean;
  onSelect: (j: Job) => void;
}> = ({ jobs, loading, onSelect }) => {
  return (
    <div>
      <h2 className="font-bold text-slate-900 text-sm mb-3">Active Jobs</h2>
      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading jobs…
        </div>
      ) : jobs.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
          <Briefcase className="w-10 h-10 mx-auto text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">No active jobs right now.</p>
        </div>
      ) : (
        <VirtualizedJobList jobs={jobs} variant="active" onSelect={onSelect} />
      )}
    </div>
  );
};



/* ----------- History View ----------- */

interface HistoryViewProps {
  search: string;
  onSearchChange: (s: string) => void;
  dateMode: 'all' | 'custom';
  onDateModeChange: (m: 'all' | 'custom') => void;
  dateRange: DateRange | undefined;
  onDateRangeChange: (r: DateRange | undefined) => void;
  summary: { jobsCount: number; items: number; totalKg: number; earliestLabel: string; monthCount: number };
  historyByMonth: { month: string; jobs: Job[]; totalWeight: number }[];
  collapsedMonths: Record<string, boolean>;
  onToggleMonth: (m: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onSelect: (j: Job) => void;
  loading: boolean;
}

const HistoryView: React.FC<HistoryViewProps> = ({
  search, onSearchChange, dateMode, onDateModeChange, dateRange, onDateRangeChange,
  summary, historyByMonth, collapsedMonths, onToggleMonth, onExpandAll, onCollapseAll,
  onSelect, loading,
}) => {
  return (
    <div className="space-y-4">
      <h2 className="font-bold text-slate-900 text-sm">Job History</h2>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search jobs by number or description..."
          className="pl-10 h-11 bg-white border-slate-200"
        />
      </div>

      {/* Date mode toggle */}
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => onDateModeChange('all')}
          className={`flex items-center justify-center gap-2 py-3 rounded-lg border text-sm font-semibold transition-colors
            ${dateMode === 'all'
              ? 'bg-[#1a1a4e] border-[#1a1a4e] text-white'
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
        >
          <Clock className="w-4 h-4" />
          All Time
        </button>
        {dateMode === 'custom' ? (
          <div className="flex items-stretch gap-2">
            <div className="flex-1">
              <HistoryDateRangePicker range={dateRange} onChange={onDateRangeChange} />
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => onDateModeChange('all')}
              className="h-11 w-11"
              title="Cancel custom range"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onDateModeChange('custom')}
            className="flex items-center justify-center gap-2 py-3 rounded-lg border bg-white border-slate-200 text-slate-600 hover:bg-slate-50 text-sm font-semibold transition-colors"
          >
            <CalendarIcon className="w-4 h-4" />
            Custom Range
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading history…
        </div>
      ) : summary.jobsCount === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
          <Clock className="w-10 h-10 mx-auto text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">No completed jobs in this range.</p>
        </div>
      ) : (
        <>
          {/* Summary card */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-slate-500" />
              <span className="text-sm text-slate-700">
                Summary {dateMode === 'all'
                  ? `- All Time${summary.earliestLabel ? ` (from ${summary.earliestLabel})` : ''}`
                  : '- Custom Range'}
              </span>
            </div>
            <div className="grid grid-cols-3 divide-x divide-slate-100">
              <SummaryStat value={summary.jobsCount} label="Jobs" />
              <SummaryStat value={summary.items} label="Items" />
              <SummaryStat value={summary.totalKg.toFixed(1)} label="Total kg" />
            </div>
          </div>

          {/* Counts row + Expand/Collapse */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">
              {summary.jobsCount} job{summary.jobsCount === 1 ? '' : 's'} in {summary.monthCount} month{summary.monthCount === 1 ? '' : 's'}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onExpandAll}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#eeeaff] text-[#1a1a4e] text-xs font-semibold hover:bg-[#e0d8ff] transition-colors"
              >
                <ChevronDown className="w-3.5 h-3.5" />
                Expand All
              </button>
              <button
                type="button"
                onClick={onCollapseAll}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#eeeaff] text-[#1a1a4e] text-xs font-semibold hover:bg-[#e0d8ff] transition-colors"
              >
                <ChevronUp className="w-3.5 h-3.5" />
                Collapse All
              </button>
            </div>
          </div>

          {/* Month groups */}
          <div className="space-y-3">
            {historyByMonth.map(({ month, jobs, totalWeight }) => {
              const collapsed = !!collapsedMonths[month];
              return (
                <div key={month} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <button
                    type="button"
                    onClick={() => onToggleMonth(month)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-[#eeeaff] flex items-center justify-center flex-shrink-0">
                        <CalendarIcon className="w-4 h-4 text-[#1a1a4e]" />
                      </div>
                      <div className="text-left min-w-0">
                        <p className="font-bold text-slate-900 text-sm">{month}</p>
                        <p className="text-xs text-slate-500">
                          {jobs.length} job{jobs.length === 1 ? '' : 's'} · {totalWeight.toFixed(1)} kg
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="inline-flex items-center justify-center min-w-[34px] h-[24px] px-2 rounded-full bg-[#1a1a4e] text-white text-[11px] font-bold">
                        {jobs.length}
                      </span>
                      {collapsed
                        ? <ChevronDown className="w-4 h-4 text-slate-400" />
                        : <ChevronUp className="w-4 h-4 text-slate-400" />}
                    </div>
                  </button>
                  {!collapsed && (
                    <div className="border-t border-slate-100 p-3 bg-slate-50/50">
                      <VirtualizedJobList
                        jobs={jobs}
                        variant="history"
                        onSelect={onSelect}
                        threshold={100}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

const SummaryStat: React.FC<{ value: React.ReactNode; label: string }> = ({ value, label }) => (
  <div className="px-1.5 sm:px-4 py-4 text-center min-w-0 overflow-hidden">
    <p className="text-sm xs:text-base sm:text-2xl font-extrabold text-slate-900 leading-tight tabular-nums whitespace-nowrap">
      {value}
    </p>
    <p className="text-[10px] sm:text-xs text-slate-500 mt-0.5 whitespace-nowrap">{label}</p>
  </div>
);

export default CustomerPortal;
