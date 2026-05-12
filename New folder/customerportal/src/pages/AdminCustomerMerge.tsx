import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { usePasswordAuth } from '@/contexts/PasswordAuthContext';
import LoginForm from '@/components/portal/LoginForm';
import RolloutStatusPanel from '@/components/portal/RolloutStatusPanel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Loader2, ShieldAlert, Users, Mail, Phone, Briefcase, ArrowLeft,
  AlertTriangle, CheckCircle2, RefreshCw, Search,
} from 'lucide-react';

// =============================================================================
// /admin/customer-merge
// -----------------------------------------------------------------------------
// Admin-only worklist for resolving the rows that 20260506_customer_auth_backfill_SQL.sql
// quarantined into public._backfill_duplicates. For each normalised email we
// show every customers row that shares it (along with phone, last job date,
// total job count) and let the operator pick a "primary" — the merge-customer
// edge function then reassigns all dependent rows from the secondaries onto
// the primary, deletes the secondaries, and re-runs the auth.users link.
//
// Access control: re-uses PasswordAuthContext. The page renders a login form
// if the operator isn't signed in, and a "Forbidden" panel if they are signed
// in as a non-admin role.
// =============================================================================

interface BackfillDup {
  customer_id: string;
  customer_name: string | null;
  email: string | null;
  conflicting_userid: string | null;
  reason: string | null;
  created_at?: string | null;
}

interface CustomerInfo {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  userId: string | null;
  jobCount: number;
  lastJobDate: string | null;
}

interface DuplicateGroup {
  email: string;            // normalised lowercase trimmed
  customers: CustomerInfo[];
  reasons: string[];        // distinct reason strings from _backfill_duplicates
}

const normEmail = (e: string | null | undefined): string =>
  String(e ?? '').trim().toLowerCase();

// -----------------------------------------------------------------------------
// Data loader. Reads _backfill_duplicates joined to customers, then layers on
// per-customer job aggregates (count + last date).
// -----------------------------------------------------------------------------
async function loadDuplicateGroups(): Promise<DuplicateGroup[]> {
  // 1. Pull every backfill duplicate row.
  const { data: dupRows, error: dupErr } = await supabase
    .from('_backfill_duplicates')
    .select('customer_id, customer_name, email, conflicting_userid, reason, created_at')
    .order('email', { ascending: true });
  if (dupErr) throw new Error(`_backfill_duplicates read failed: ${dupErr.message}`);
  const dups = (dupRows ?? []) as BackfillDup[];
  if (dups.length === 0) return [];

  // 2. Find the customers rows referenced by those dup rows AND any other
  //    customers rows that share the same normalised email — operators
  //    typically want to merge the duplicate into a still-linked canonical.
  const dupCustomerIds = Array.from(new Set(dups.map((d) => d.customer_id))).filter(Boolean);
  const dupEmails = Array.from(new Set(dups.map((d) => normEmail(d.email)).filter(Boolean)));

  const customerById = new Map<string, CustomerInfo>();

  // a. By id
  if (dupCustomerIds.length > 0) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, email, phone, "userId"')
      .in('id', dupCustomerIds);
    if (error) throw new Error(`customers by id failed: ${error.message}`);
    for (const r of (data ?? []) as any[]) {
      customerById.set(r.id, {
        id: r.id, name: r.name, email: r.email, phone: r.phone,
        userId: r.userId ?? null, jobCount: 0, lastJobDate: null,
      });
    }
  }
  // b. By email — pull every customers row sharing one of the dup emails so
  //    the canonical (already-linked) row appears alongside its duplicates.
  if (dupEmails.length > 0) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, email, phone, "userId"')
      .in('email', dupEmails);
    if (!error) {
      for (const r of (data ?? []) as any[]) {
        if (!customerById.has(r.id)) {
          customerById.set(r.id, {
            id: r.id, name: r.name, email: r.email, phone: r.phone,
            userId: r.userId ?? null, jobCount: 0, lastJobDate: null,
          });
        }
      }
    }
    // Case-insensitive secondary pass for emails stored with mixed case.
    for (const e of dupEmails) {
      const { data, error: e2 } = await supabase
        .from('customers')
        .select('id, name, email, phone, "userId"')
        .ilike('email', e);
      if (!e2) {
        for (const r of (data ?? []) as any[]) {
          if (!customerById.has(r.id)) {
            customerById.set(r.id, {
              id: r.id, name: r.name, email: r.email, phone: r.phone,
              userId: r.userId ?? null, jobCount: 0, lastJobDate: null,
            });
          }
        }
      }
    }
  }

  const allCustomerIds = Array.from(customerById.keys());

  // 3. Per-customer job aggregates. PostgREST doesn't expose GROUP BY
  //    naturally, so we fetch a slim projection and aggregate client-side.
  //    For an admin tool this is fine; the duplicate set is rarely > a few
  //    hundred rows.
  if (allCustomerIds.length > 0) {
    const { data: jobs, error: jobsErr } = await supabase
      .from('jobs')
      .select('id, customerId, dateOfEntry, updatedAt, created_at')
      .in('customerId', allCustomerIds)
      .limit(20000);
    if (!jobsErr && jobs) {
      for (const j of jobs as any[]) {
        const cid = j.customerId;
        const c = customerById.get(cid);
        if (!c) continue;
        c.jobCount += 1;
        const ts =
          j.dateOfEntry || j.updatedAt || j.created_at || null;
        if (ts) {
          if (!c.lastJobDate || new Date(ts).getTime() > new Date(c.lastJobDate).getTime()) {
            c.lastJobDate = ts;
          }
        }
      }
    }
  }

  // 4. Group by normalised email.
  const groups = new Map<string, DuplicateGroup>();

  // Seed groups from dups so even an "email == NULL / empty" gets a bucket.
  for (const d of dups) {
    const key = normEmail(d.email) || `__no_email__:${d.customer_id}`;
    if (!groups.has(key)) groups.set(key, { email: key, customers: [], reasons: [] });
    if (d.reason && !groups.get(key)!.reasons.includes(d.reason)) {
      groups.get(key)!.reasons.push(d.reason);
    }
  }

  // Add every customer row whose email matches a group key (or whose id
  // matches a dup row directly).
  const dupCustomerIdSet = new Set(dupCustomerIds);
  for (const c of customerById.values()) {
    const ek = normEmail(c.email);
    if (ek && groups.has(ek)) {
      const g = groups.get(ek)!;
      if (!g.customers.find((x) => x.id === c.id)) g.customers.push(c);
      continue;
    }
    if (dupCustomerIdSet.has(c.id)) {
      // Falls into a no-email bucket keyed by its own id.
      const key = `__no_email__:${c.id}`;
      if (!groups.has(key)) groups.set(key, { email: key, customers: [], reasons: [] });
      if (!groups.get(key)!.customers.find((x) => x.id === c.id)) {
        groups.get(key)!.customers.push(c);
      }
    }
  }

  // Drop empty buckets, sort customers within each group: linked first
  // (most likely canonical), then highest job count.
  const out: DuplicateGroup[] = [];
  for (const g of groups.values()) {
    if (g.customers.length === 0) continue;
    g.customers.sort((a, b) => {
      const aLinked = a.userId ? 1 : 0;
      const bLinked = b.userId ? 1 : 0;
      if (aLinked !== bLinked) return bLinked - aLinked;
      return b.jobCount - a.jobCount;
    });
    out.push(g);
  }

  // Sort groups: most-rows first, then by email.
  out.sort((a, b) => {
    if (a.customers.length !== b.customers.length) return b.customers.length - a.customers.length;
    return a.email.localeCompare(b.email);
  });

  return out;
}

// -----------------------------------------------------------------------------
// Group card. Renders each customers row with a radio selector for primary.
// -----------------------------------------------------------------------------
const GroupCard: React.FC<{
  group: DuplicateGroup;
  onMerge: (primaryId: string, secondaryIds: string[], email: string) => Promise<void>;
  busyId: string | null;
}> = ({ group, onMerge, busyId }) => {
  const [primaryId, setPrimaryId] = useState<string>(() => group.customers[0]?.id ?? '');
  const noEmail = group.email.startsWith('__no_email__');
  const displayEmail = noEmail ? '(no email)' : group.email;

  const secondaries = useMemo(
    () => group.customers.filter((c) => c.id !== primaryId).map((c) => c.id),
    [group.customers, primaryId],
  );

  const groupBusy = busyId === group.email;
  const canMerge = !!primaryId && secondaries.length > 0 && !groupBusy;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Mail className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <span className="font-mono text-sm text-slate-800 truncate">{displayEmail}</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 flex-shrink-0">
            {group.customers.length} rows
          </span>
        </div>
        <Button
          size="sm"
          disabled={!canMerge}
          onClick={() => onMerge(primaryId, secondaries, noEmail ? '' : group.email)}
          className="bg-[#1a1a4e] hover:bg-[#2a2a6e] text-white"
        >
          {groupBusy ? (
            <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Merging…</>
          ) : (
            <>Merge {secondaries.length} into primary</>
          )}
        </Button>
      </div>

      {group.reasons.length > 0 && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-800 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{group.reasons.join(' · ')}</span>
        </div>
      )}

      <div className="divide-y divide-slate-100">
        {group.customers.map((c) => {
          const isPrimary = c.id === primaryId;
          return (
            <label
              key={c.id}
              className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${
                isPrimary ? 'bg-[#eeeaff]' : 'hover:bg-slate-50'
              }`}
            >
              <input
                type="radio"
                name={`primary-${group.email}`}
                checked={isPrimary}
                onChange={() => setPrimaryId(c.id)}
                className="mt-1"
              />
              <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-4 gap-x-4 gap-y-1 text-sm">
                <div className="font-semibold text-slate-900 truncate flex items-center gap-1.5">
                  {c.name || '(unnamed)'}
                  {c.userId && (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" aria-label="Linked to auth.users" />
                  )}
                </div>
                <div className="text-slate-600 flex items-center gap-1 truncate">
                  <Phone className="w-3 h-3 text-slate-400" /> {c.phone || '—'}
                </div>
                <div className="text-slate-600 flex items-center gap-1">
                  <Briefcase className="w-3 h-3 text-slate-400" /> {c.jobCount} jobs
                </div>
                <div className="text-slate-500 text-xs">
                  Last: {c.lastJobDate ? new Date(c.lastJobDate).toLocaleDateString() : '—'}
                </div>
                <div className="sm:col-span-4 text-[11px] text-slate-400 font-mono truncate">
                  id={c.id} · userId={c.userId ?? '—'}
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
};

// -----------------------------------------------------------------------------
// Page component.
// -----------------------------------------------------------------------------
const AdminCustomerMerge: React.FC = () => {
  const { user, loading: authLoading, logout } = usePasswordAuth();
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [resultLog, setResultLog] = useState<string[]>([]);

  const isAdmin = !!user && user.role === 'admin';

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const g = await loadDuplicateGroups();
      setGroups(g);
    } catch (e: any) {
      setError(e?.message || 'Failed to load duplicates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) refresh();
  }, [isAdmin, refresh]);

  const onMerge = useCallback(
    async (primaryId: string, secondaryIds: string[], email: string) => {
      setBusyId(email || `__no_email__:${primaryId}`);
      try {
        const { data, error: invokeErr } = await supabase.functions.invoke('merge-customer', {
          body: { primaryId, secondaryIds, email: email || null },
          headers: user ? { 'x-portal-user': JSON.stringify(user) } : undefined,
        });
        if (invokeErr) throw new Error(invokeErr.message);
        if (data?.error) throw new Error(data.error);
        setResultLog((prev) => [
          `[${new Date().toLocaleTimeString()}] Merged ${secondaryIds.length} → ${primaryId.slice(0, 8)}…  ` +
            `link=${JSON.stringify((data as any)?.authLinkResult ?? {})}`,
          ...prev,
        ].slice(0, 20));
        await refresh();
      } catch (e: any) {
        setResultLog((prev) => [
          `[${new Date().toLocaleTimeString()}] FAILED: ${e?.message || String(e)}`,
          ...prev,
        ].slice(0, 20));
      } finally {
        setBusyId(null);
      }
    },
    [refresh, user],
  );

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => {
      if (g.email.includes(q)) return true;
      return g.customers.some(
        (c) =>
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.phone && c.phone.toLowerCase().includes(q)) ||
          (c.id.toLowerCase().includes(q)),
      );
    });
  }, [groups, search]);

  // ----- Auth gates -----
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 max-w-md text-center">
          <ShieldAlert className="w-10 h-10 mx-auto text-red-500" />
          <h1 className="mt-3 font-bold text-slate-900">Forbidden</h1>
          <p className="mt-1 text-sm text-slate-600">
            This page is restricted to admin users. You're signed in as
            <span className="font-mono"> {user.username} ({user.role})</span>.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="outline" onClick={logout}>Sign out</Button>
            <Link to="/">
              <Button variant="default">Back to portal</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-[#1a1a4e] text-white shadow">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-3 justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Users className="w-5 h-5 flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="font-bold text-base leading-tight truncate">Customer Merge</h1>
              <p className="text-[11px] text-white/70 truncate">
                Resolve duplicates from public._backfill_duplicates
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button size="sm" variant="ghost" className="text-white hover:bg-white/10">
                <ArrowLeft className="w-4 h-4 mr-1" /> Portal
              </Button>
            </Link>
            <Button size="sm" variant="ghost" className="text-white hover:bg-white/10" onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        {/* Production rollout dashboard — live counts + one-click backfill, */}
        {/* Step C SQL pointers, leak probe, and rollback. Sits above the     */}
        {/* duplicate worklist so operators see the macro picture first.     */}
        <RolloutStatusPanel />

        <div className="border-t border-slate-200 pt-5">
          <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3">
            Duplicate worklist
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by email, name, phone, or id…"
              className="pl-10 bg-white"
            />
          </div>
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <div className="text-sm text-slate-600">
            {loading ? 'Loading…' : `${filteredGroups.length} group${filteredGroups.length === 1 ? '' : 's'} · `}
            {!loading && (
              <span>
                {filteredGroups.reduce((n, g) => n + g.customers.length, 0)} customer rows
              </span>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-3 py-2 text-sm">
            {error}
          </div>
        )}

        {resultLog.length > 0 && (
          <div className="bg-slate-900 text-slate-100 rounded-md px-3 py-2 text-xs font-mono space-y-0.5">
            {resultLog.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}

        {loading && groups.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading duplicates…
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
            <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-500" />
            <p className="mt-3 text-sm text-slate-700 font-semibold">No duplicates to resolve.</p>
            <p className="mt-1 text-xs text-slate-500">
              public._backfill_duplicates is empty (or your search excludes everything).
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredGroups.map((g) => (
              <GroupCard key={g.email} group={g} onMerge={onMerge} busyId={busyId} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default AdminCustomerMerge;
