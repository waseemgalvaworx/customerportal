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

// A job is moved to History only once it has been physically dispatched
// or otherwise terminally closed. In this operation's workflow, statuses
// like `ready`, `done`, `complete`, `completed`, `finished` mean
// "processing has finished but the goods are still in our yard waiting to
// be collected / delivered" — those jobs MUST stay on the Active tab so
// the customer can see them and arrange collection.
//
// ONLY truly post-handover statuses move a job into History:
//   shipped / delivered  — left our premises
//   cancelled / canceled — abandoned
//   archived / closed    — operator explicitly closed the file
//
// We use EXACT (trimmed/lowercased) match — substring matching would
// misclassify e.g. "ready_for_dispatch" or "in_progress_completed_step".
const HISTORY_STATUSES = new Set([
  'shipped', 'delivered',
  'cancelled', 'canceled',
  'archived', 'closed',
]);

// Cutoff: do NOT show history jobs older than this. Per business rule we
// only display jobs from January 2026 onwards in the History tab.
const HISTORY_CUTOFF_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0); // 2026-01-01 00:00 UTC

const isHistoryJob = (job: Job): boolean => {
  // NOTE: We do NOT auto-classify `archived === true` boolean as history
  // either — only the explicit terminal status string above. A job sitting
  // as "ready" / "done" stays on Active until the operator marks it
  // shipped, delivered, archived, or closed.
  const s = (job.status || '').toLowerCase().trim();
  if (!s) return false;
  return HISTORY_STATUSES.has(s);
};

// Returns the timestamp we use to bucket a history job into a month.
// Prefer updated_at (when it transitioned to its terminal state) and
// fall back to created_at.
const historyJobTimestamp = (j: Job): number => {
  const ref = j.updated_at || j.created_at;
  if (!ref) return 0;
  const t = new Date(ref).getTime();
  return Number.isFinite(t) ? t : 0;
};






// All dates in this portal are formatted in the Mauritius timezone (GMT+4).
// We use `en-GB` so Intl returns deterministic, parse-friendly strings
// regardless of the viewer's device locale (e.g. "April 2026" not "avril 2026").
const PORTAL_TIMEZONE = 'Indian/Mauritius';

// Returns the Y/M of a date, AS OBSERVED in Mauritius. Used so a job
// updated at 23:30 UTC on 30 Apr (= 03:30 1 May Mauritius) groups under May.
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

// Stable key for "the current month, in Mauritius" — used to decide which
// history group is auto-expanded on first render.
const currentMauritiusMonthKey = (): string => monthKey(new Date().toISOString());

// Total weight resolution mirrors JobCard / RN portal: fall back to summing
// items[].weightKg when no server-aggregated total is present.
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



// Roles that should be scoped to a single customer's data.
// `customer` = legacy/unified role. `customer_portal` = dedicated
// customer-portal-only role used by the original RN portal.
const CUSTOMER_SCOPED_ROLES = new Set(['customer', 'customer_portal']);
const isCustomerScoped = (user: any): boolean => {
  if (!user) return false;
  if (CUSTOMER_SCOPED_ROLES.has(user.role)) return true;
  // Defense-in-depth: if their ONLY allowed screen is the customer portal,
  // treat them as a scoped customer regardless of role label.
  const a = user.permissions?.allowedScreens;
  if (Array.isArray(a) && a.length === 1 && a.includes('customer-portal')) return true;
  return false;
};

const CustomerPortal: React.FC = () => {
  const { user, logout } = usePasswordAuth();
  const { subscribe, reconnect } = useRealtime();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [dateMode, setDateMode] = useState<'all' | 'custom'>('all');
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [collapsedMonths, setCollapsedMonths] = useState<Record<string, boolean>>({});

  // On-screen debug log (hidden by default — toggle via tiny corner button).
  // Useful when the browser console isn't available (e.g. in-app webview).
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showDebug, setShowDebug] = useState<boolean>(false);
  const dbg = useCallback((msg: string, data?: any) => {
    const line = data !== undefined
      ? `${new Date().toLocaleTimeString()}  ${msg}  ${JSON.stringify(data)}`
      : `${new Date().toLocaleTimeString()}  ${msg}`;
    setDebugLog((prev) => [...prev.slice(-49), line]);
  }, []);



  // Customer record resolved client-side from the `customers` table.
  // We deliberately DO NOT call the `customer-jobs` edge function: it is
  // deployed in a different Supabase project than where the data lives, so
  // its service-role key cannot reach the customers/jobs tables (logs show
  // "Authorization token is required" for every lookup attempt). Until the
  // function is redeployed against the data project, the only working path
  // is the client-side scoped query below.
  const [customerRecord, setCustomerRecord] = useState<{ id: string; name: string } | null>(null);

  const scopedCustomerName = customerRecord?.name ?? null;
  const scopedCustomerId = customerRecord?.id ?? null;

  // Defensive client-side scoped fetch.
  //   1. Resolve the `customers` row for the logged-in user via, in order:
  //        - customers.userId  = user.id
  //        - customers.user_id = user.id
  //        - customers.id      = user.customer_id (if present)
  //        - customers.name    ILIKE user.username (last resort)
  //   2. Query `jobs` with `.eq('customerId', resolved.id)` (UUID — robust
  //      to name typos / casing). Retry by `customerName` if the column
  //      query is rejected.
  //   3. Apply a final belt-and-braces client-side filter so a row whose
  //      linkage doesn't match the resolved customer can never render.
  //   4. Fail closed (empty list + clear message) if no customer can be
  //      resolved — never leak unscoped jobs.
  const fetchJobs = useCallback(async () => {
    if (!user) {
      return;
    }
    setError(null);

    const scoped = isCustomerScoped(user);

    dbg('fetchJobs called', {
      hasUser: !!user,
      username: user?.username,
      userId: user?.id,
      role: user?.role,
      scoped,
      allowedScreens: (user as any)?.permissions?.allowedScreens,
    });

    if (!scoped) {
      dbg('REFUSING: user is not customer-scoped', { role: user.role });
      setJobs([]);
      setCustomerRecord(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    try {
      dbg('Resolving customer record client-side', {
        username: user.username,
        userId: user.id,
        role: user.role,
      });

      // Customer lookup candidates. The `customers` table uses snake_case
      // (`user_id`) — we skip the camelCase `userId` lookup because it will
      // always error with "column does not exist" and just adds noise to logs.
      const candidates: Array<{ column: string; value: string }> = [];
      if (user.id) {
        candidates.push({ column: 'user_id', value: user.id });
      }
      const cid = (user as any).customer_id ?? (user as any).customerId ?? null;
      if (cid) candidates.push({ column: 'id', value: cid });
      dbg('lookup candidates', candidates);

      let resolved: { id: string; name: string } | null = null;
      let lookupMethod = '';

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
        dbg(`customer lookup by ${c.column}`, { found: !!data, data });
        if (data) {
          resolved = data as any;
          lookupMethod = c.column;
          break;
        }
      }

      // Last resort: case-insensitive username -> customers.name
      if (!resolved && user.username) {
        const { data, error: lookupErr } = await supabase
          .from('customers')
          .select('id, name')
          .ilike('name', user.username.trim())
          .limit(1)
          .maybeSingle();
        dbg('customer lookup by username->name(ilike)', {
          found: !!data, data, err: lookupErr?.message,
        });
        if (!lookupErr && data) {
          resolved = data as any;
          lookupMethod = 'username->name(ilike)';
        }
      }

      if (!resolved) {
        dbg('FAIL CLOSED: could not resolve customer for this user');
        setCustomerRecord(null);
        setJobs([]);
        setError('Your account is not linked to a customer profile. Please contact your account manager.');
        return;
      }

      setCustomerRecord({ id: resolved.id, name: resolved.name });

      // Jobs query — confirmed schema uses `jobs.customerName` (camelCase
      // text column). We also UNION any rows linked by `jobs.customerId`
      // (uuid) in case some rows have only the FK populated.
      //
      // We explicitly select `items` (the JSON array of line items) in
      // addition to `*` because some Supabase / PostgREST configurations
      // omit large jsonb columns from the implicit `*` projection. Without
      // this, the description/qty/weight resolvers see an empty array and
      // fall back to the catch-all "standard" / "Item N" placeholders.
      const SELECT_COLS = '*, items, customers(name)';

      const byId = new Map<string, any>();
      const merge = (arr: any[] | null | undefined) => {
        for (const r of arr ?? []) {
          if (r && r.id != null) byId.set(String(r.id), r);
        }
      };

      // Primary: name-based linkage (this is where the data actually lives).
      // We use ilike with a trimmed value so trailing whitespace / casing
      // differences in jobs.customerName don't drop legitimate rows
      // (this is the most common reason jobs 160085-87 etc. go missing).
      const trimmedName = (resolved.name || '').trim();
      const rName = await supabase
        .from('jobs')
        .select(SELECT_COLS)
        .ilike('customerName', trimmedName)
        .order('updatedAt', { ascending: false })
        .limit(2000);
      dbg('jobs by customerName(ilike)', {
        nameQuery: trimmedName,
        err: rName.error?.message, count: rName.data?.length ?? 0,
      });
      if (!rName.error) merge(rName.data);

      // Secondary: uuid FK linkage (catches any rows without the name set)
      const rId = await supabase
        .from('jobs')
        .select(SELECT_COLS)
        .eq('customerId', resolved.id)
        .limit(2000);
      dbg('jobs by customerId(uuid)', {
        err: rId.error?.message, count: rId.data?.length ?? 0,
      });
      if (!rId.error) merge(rId.data);

      const rows = Array.from(byId.values());

      const mapped: Job[] = normalizeRows(rows).map((j: any) => ({
        ...j,
        customer_name: j.customers?.name || j.customer_name || resolved!.name,
      }));

      // Final defensive client filter — drop ANY row whose linkage doesn't
      // match the resolved customer. We compare names case-insensitively
      // (and trimmed) so minor data-entry inconsistencies don't drop rows.
      const normName = (s: any) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
      const wantName = normName(resolved!.name);
      const finalJobs = mapped.filter((j: any) => {
        const jn = normName(j.customer_name ?? j.customerName ?? null);
        const jc = j.customer_id ?? j.customerId ?? null;
        return jn === wantName || jc === resolved!.id;
      });

      // Per-job diagnostic: surface the items[] shape for the first few
      // jobs so we can confirm the JSON column is actually being returned
      // and inspect what field names line items use on this customer.
      const sample = finalJobs.slice(0, 3).map((j: any) => ({
        job_number: j.job_number,
        status: j.status,
        customerName: j.customerName ?? j.customer_name,
        itemsLen: Array.isArray(j.items) ? j.items.length : null,
        firstItemKeys: Array.isArray(j.items) && j.items[0]
          ? Object.keys(j.items[0]) : null,
      }));
      dbg('Scoped query result', {
        lookupMethod,
        resolvedId: resolved.id,
        resolvedName: resolved.name,
        rawCount: mapped.length,
        scopedCount: finalJobs.length,
        activeCount: finalJobs.filter((j) => !isHistoryJob(j)).length,
        historyCount: finalJobs.filter((j) => isHistoryJob(j)).length,
        sample,
      });


      setJobs(finalJobs);

    } catch (e: any) {
      dbg('fetch jobs FAILED', { msg: e?.message });
      setError(e?.message || 'Failed to load jobs');
      setJobs([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, dbg]);






  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  // Realtime: re-invoke the edge function on any jobs change, rather than
  // mutating local state from raw `jobs` rows the client now never queries.
  useEffect(() => {
    if (!user || !isCustomerScoped(user)) return;
    const refetchSoon = (() => {
      let t: any;
      return () => { clearTimeout(t); t = setTimeout(fetchJobs, 600); };
    })();
    const u1 = subscribe('jobs', refetchSoon);
    const u2 = subscribe('quality_control', refetchSoon);
    const u3 = subscribe('item_stage_tracking', refetchSoon);
    return () => { u1(); u2(); u3(); };
  }, [subscribe, fetchJobs, user]);


  const handleRefresh = () => {
    setRefreshing(true);
    reconnect();
    fetchJobs();
  };



  const counts = useMemo(() => {
    let active = 0, history = 0;
    for (const j of jobs) {
      if (isHistoryJob(j)) history++; else active++;
    }
    return { active, history };
  }, [jobs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.filter((j) => {
      const history = isHistoryJob(j);
      if (tab === 'active' && history) return false;
      if (tab === 'history' && !history) return false;

      // History tab: hide anything older than the Jan 2026 cutoff.
      if (tab === 'history') {
        const ts = historyJobTimestamp(j);
        if (ts > 0 && ts < HISTORY_CUTOFF_MS) return false;
      }

      if (tab === 'history' && dateMode === 'custom' && dateRange?.from) {
        const ts = j.updated_at ? new Date(j.updated_at).getTime() : 0;
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
  }, [jobs, tab, search, dateMode, dateRange]);


  // History grouped by month
  const historyByMonth = useMemo(() => {
    if (tab !== 'history') return [] as { month: string; sortKey: number; jobs: Job[]; totalWeight: number }[];
    const groups: Record<string, { jobs: Job[]; sortKey: number; totalWeight: number }> = {};
    for (const j of filtered) {
      const ref = j.updated_at || j.created_at;
      const k = monthKey(ref);
      if (!groups[k]) groups[k] = { jobs: [], sortKey: monthSortKey(ref), totalWeight: 0 };
      groups[k].jobs.push(j);
      groups[k].totalWeight += getJobWeight(j);
    }
    return Object.entries(groups)
      .map(([month, g]) => ({ month, ...g }))
      .sort((a, b) => b.sortKey - a.sortKey);
  }, [filtered, tab]);

  // Summary stats for history tab
  const historySummary = useMemo(() => {
    const jobsCount = filtered.length;
    let items = 0;
    let totalKg = 0;
    let earliest: number | null = null;
    for (const j of filtered) {
      // Same item-count fallback as JobCard: prefer server total, else
      // sum the embedded items[] array length.
      const directItems = Number(j.total_items ?? 0);
      const fallbackItems = Array.isArray((j as any).items) ? (j as any).items.length : 0;
      items += directItems > 0 ? directItems : fallbackItems;
      totalKg += getJobWeight(j);
      const t = j.updated_at || j.created_at;
      if (t) {
        const ts = new Date(t).getTime();
        if (earliest === null || ts < earliest) earliest = ts;
      }
    }
    let earliestLabel = '';
    if (earliest !== null) {
      earliestLabel = new Date(earliest).toLocaleDateString('en-GB', {
        timeZone: PORTAL_TIMEZONE,
        month: 'short', year: 'numeric',
      });
    }
    return { jobsCount, items, totalKg, earliestLabel, monthCount: historyByMonth.length };
  }, [filtered, historyByMonth]);


  // Apply default collapse state: every month starts collapsed EXCEPT the
  // current Mauritius month, which starts expanded. We only set this for
  // months we haven't seen before, so a user who manually toggles a month
  // keeps their choice even when the realtime refetch reshapes the list.
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
        // Default: collapsed unless it's the current Mauritius month
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
  // No modal/popup; the user navigates back via the header back button.
  // Wrapped in <Suspense> because the details view is a lazy() chunk.
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
            {error}
          </div>
        )}

        {tab === 'active' ? (
          <ActiveJobsView
            jobs={filtered}
            loading={loading}
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
            loading={loading}
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
        // VirtualizedJobList renders a plain list under 50 items and
        // switches to windowed rendering for larger active job sets.
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
                      {/* Virtualize months with >100 jobs; otherwise render plainly */}
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

// SummaryStat — three-up KPI cell. The Total kg value can get long
// (e.g. "12345.6", "123456.7"), so on narrow mobile widths we drop
// the font size and remove `truncate` so digits aren't ellipsised.
// We use whitespace-nowrap (one line) + min-w-0 + responsive font
// sizing so all digits remain readable down to ~340px viewport widths.
const SummaryStat: React.FC<{ value: React.ReactNode; label: string }> = ({ value, label }) => (
  <div className="px-1.5 sm:px-4 py-4 text-center min-w-0 overflow-hidden">
    <p className="text-sm xs:text-base sm:text-2xl font-extrabold text-slate-900 leading-tight tabular-nums whitespace-nowrap">
      {value}
    </p>
    <p className="text-[10px] sm:text-xs text-slate-500 mt-0.5 whitespace-nowrap">{label}</p>
  </div>
);



export default CustomerPortal;
