import React, { useEffect, useMemo, useState, useCallback } from 'react';

import {
  Loader2, Package, FileText, History as HistoryIcon, MessageSquare,
  Box, Calendar as CalendarIcon, ArrowLeft, ArrowRight, GitBranch,
  CheckCircle2, Truck, User, StickyNote,
} from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { normalizeRows } from '@/lib/normalize';
import { extractContactName } from '@/lib/extractContactName';
import { type Job, resolveJobNotes } from './JobCard';

import { stageStyleFor, classifyStage, STAGE_STYLES, type StageKey } from '@/lib/stageColors';
import { deriveEffectiveStage } from '@/lib/effectiveStage';




interface Props {
  job: Job;
  onBack: () => void;
}


// A normalised "stage transition" event for the customer-facing item
// timeline. We synthesise this shape from rows in the `activity_logs`
// table (action_type = 'ITEM_STATUS_CHANGED'), matching the reference
// React Native portal's data source. We intentionally DO NOT use
// `item_stage_tracking` for the customer view — operations log stage
// changes via activity_logs and that's the canonical source customers
// should see (it captures every Pending → Workshop → Acid → Galva →
// Finishing → Ready hop with timestamps).
interface StageEvent {
  id: string;
  job_id?: string | null;
  job_number?: string | null;
  item_id?: string | null;
  item_name?: string | null;          // resolved description (metadata.itemDescription)
  from_stage?: string | null;         // metadata.oldStatus
  to_stage?: string | null;           // metadata.newStatus
  stage?: string | null;              // alias for to_stage (compat with old shape)
  status?: string | null;
  updated_at?: string | null;         // activity_logs.created_at
  created_at?: string | null;
  notes?: string | null;
}

interface QualityRecord {
  id: string;
  job_id: string;
  inspector?: string | null;
  result?: string | null;
  notes?: string | null;
  inspected_at?: string | null;
  created_at?: string | null;
}


// All dates in this portal are formatted in the Mauritius timezone (GMT+4)
// regardless of the viewer's device locale, since the operations team and
// customers are based there.
const PORTAL_TIMEZONE = 'Indian/Mauritius';

const formatDate = (d?: string | null, opts?: Intl.DateTimeFormatOptions) => {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('en-GB', {
      timeZone: PORTAL_TIMEZONE,
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      ...(opts || {}),
    });
  } catch { return '—'; }
};

const formatShortDate = (d?: string | null) => formatDate(d, {
  year: undefined, hour: undefined, minute: undefined,
  month: 'short', day: 'numeric',
});

const formatLongDate = (d?: string | null) => formatDate(d, {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

// Only TRULY post-handover statuses get the "Completed" treatment on the
// details screen. `ready` / `done` / `complete` are processing-finished
// states — the goods are still in our yard until they're shipped or
// archived. This list MUST stay in sync with HISTORY_STATUSES in
// CustomerPortal.tsx (where the Active/History tab split is decided).
const HISTORY_STATUSES = ['shipped', 'delivered', 'cancelled', 'canceled', 'archived', 'closed'];

const isCompleted = (status?: string | null): boolean => {
  if (!status) return false;
  const s = status.toLowerCase().trim();
  return HISTORY_STATUSES.some((h) => s === h);
};

// Resolve the status label shown on the details summary pill. Mirrors
// the JobCard logic so the details screen stays consistent with the
// list:
//   - terminal statuses (shipped/delivered/cancelled/archived/closed)
//     -> matching terminal label
//   - otherwise driven by the EFFECTIVE STAGE of the job (i.e. derived
//     from items[].status, not the loose job.status):
//       * all items pending          -> "Waiting"
//       * all items at ready/terminal -> "Ready"
//       * any item past pending       -> "In Progress"
const formatStatus = (job: Job | { status?: string | null }): string => {
  const s = (job as any)?.status;
  if (s) {
    const lower = String(s).toLowerCase().trim();
    if (lower === 'shipped') return 'Shipped';
    if (lower === 'delivered') return 'Delivered';
    if (lower === 'cancelled' || lower === 'canceled') return 'Cancelled';
    if (lower === 'archived' || lower === 'closed') return 'Completed';
  }
  // Derive from items[].status — this is the canonical source.
  const stage = deriveEffectiveStage(job);
  if (stage === 'pending') return 'Waiting';
  if (stage === 'ready') return 'Ready';
  return 'In Progress';
};



// The shared backend may store the per-job line items under any of these
// keys depending on which tool wrote the row (web admin, RN portal,
// legacy importer). We resolve the FIRST non-empty array we find so the
// portal works regardless of which writer populated the column.
const ITEMS_ARRAY_KEYS = ['items', 'lineItems', 'line_items', 'jobItems', 'job_items', 'parts', 'products'];

const getJobItems = (j: any): any[] => {
  if (!j || typeof j !== 'object') return [];
  for (const k of ITEMS_ARRAY_KEYS) {
    const v = j[k];
    if (Array.isArray(v) && v.length > 0) return v;
    // Some writers store the items as a JSON string. Try to parse.
    if (typeof v === 'string' && v.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch { /* noop */ }
    }
  }
  return [];
};

const getItemsWeight = (items: any[] | undefined | null): number => {
  if (!items || !Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    const w = parseFloat(String(item?.weightKg ?? item?.weight ?? '0'));
    return sum + (isFinite(w) ? w : 0);
  }, 0);
};

const getJobWeight = (j: Job): number => {
  const direct = (j as any).total_weight ?? (j as any).weight;
  const n = Number(direct);
  if (direct != null && isFinite(n) && n > 0) return n;
  return getItemsWeight(getJobItems(j));
};


// Resolve a human-readable description for a per-job line item.
//
// The shared backend stores `items` as a JSON array on the job, but the
// schema for entries is loose. Different operators / sites use different
// field names, so we have to try a wide range of likely keys.
//
// Resolution order:
//   1. Explicit description-style fields on the ITEM
//      (description, itemDescription, partDescription, productDescription...).
//   2. Explicit name-style fields on the ITEM (name, title, productName,
//      partName, materialName, label, partNumber, sku, code).
//   3. CAUTIOUS catch-all: any other string field on the item whose KEY
//      is not in the deny-list (category / status / metadata fields like
//      `coatingType`, `process`, `service`, `status`, `stage`, `type` —
//      these surface meaningless tokens like "standard" / "in_progress"
//      and were the cause of the previous "standard" bug). We also skip
//      UUIDs, numerics, and very short tokens.
//   4. The parent job's description (only as a fallback so we don't mask
//      per-item names).
//   5. "Item N" placeholder.
const ITEM_TRUE_DESCRIPTION_KEYS: string[] = [
  'description', 'itemDescription', 'item_description',
  'productDescription', 'product_description',
  'partDescription', 'part_description',
  'materialDescription', 'material_description',
  'longDescription', 'long_description',
  'fullDescription', 'full_description',
  'desc', 'details', 'detail', 'spec', 'specification',
  'remarks', 'remark', 'comment', 'comments', 'note', 'notes',
];

const ITEM_NAME_KEYS: string[] = [
  'name',
  'title',
  'productName', 'product_name',
  'partName', 'part_name',
  'materialName', 'material_name',
  'itemName', 'item_name',
  'product', 'part', 'material', 'item',
  'label',
  'partNumber', 'part_number',
  'productCode', 'product_code',
  'sku', 'code', 'reference', 'ref',
];

// Keys we MUST NEVER use as a description, even via the catch-all.
// These are categorisations / status fields / metadata — they tend to
// hold short canonical tokens like "standard", "premium", "in_progress",
// "pending", "kg", which are not useful as item descriptions.
const ITEM_DENY_KEYS: Set<string> = new Set([
  'id', 'itemid', 'item_id', 'jobid', 'job_id', 'uuid',
  'status', 'stage', 'state', 'phase',
  'type', 'kind', 'category', 'class', 'classification',
  'service', 'serviceType', 'service_type',
  'process', 'processType', 'process_type',
  'coating', 'coatingType', 'coating_type',
  'finish', 'finishType', 'finish_type',
  'treatment', 'treatmentType', 'treatment_type',
  'grade', 'tier', 'level', 'priority',
  'unit', 'units', 'uom',
  'weight', 'weightkg', 'weight_kg', 'mass',
  'quantity', 'qty', 'count', 'pieces', 'pcs',
  'price', 'cost', 'rate', 'amount', 'total', 'subtotal',
  'currency',
  'createdat', 'created_at', 'updatedat', 'updated_at',
  'createdby', 'created_by', 'updatedby', 'updated_by',
  'completedat', 'completed_at', 'receivedat', 'received_at',
  'archived', 'deleted', 'active', 'enabled', 'visible',
  'icon', 'image', 'photo', 'thumbnail', 'url', 'link',
  'color', 'colour',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const SHORT_TOKEN_RE = /^[a-z0-9_-]{1,12}$/i; // single short snake/lower token

const isUsableString = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t.length === 0) return false;
  if (UUID_RE.test(t)) return false;
  if (NUMERIC_RE.test(t)) return false;
  return true;
};

// Stricter check used by the catch-all step. Rejects single short
// lowercase tokens (e.g. "standard", "premium", "kg", "in_progress")
// that are almost certainly category labels rather than descriptions.
const isLikelyDescription = (v: unknown): v is string => {
  if (!isUsableString(v)) return false;
  const t = (v as string).trim();
  if (t.length < 4) return false;
  // Multi-word strings or strings containing spaces / punctuation are
  // very likely real descriptions.
  if (/\s/.test(t)) return true;
  if (/[A-Z]/.test(t) && /[a-z]/.test(t)) return true; // mixed case e.g. "PillarPlate"
  if (/\d/.test(t) && /[a-zA-Z]/.test(t)) return true; // alphanumeric e.g. "RHS50x50"
  // Otherwise reject single short lowercase tokens
  return !SHORT_TOKEN_RE.test(t);
};

const resolveItemDescription = (
  it: any,
  idx: number,
  jobDescription?: string | null,
): string => {
  if (it && typeof it === 'object') {
    // 1. Explicit description fields on the item
    for (const k of ITEM_TRUE_DESCRIPTION_KEYS) {
      const v = it[k];
      if (isUsableString(v)) return v.trim();
    }
    // 2. Explicit name-style fields on the item
    for (const k of ITEM_NAME_KEYS) {
      const v = it[k];
      if (isUsableString(v)) return v.trim();
    }
    // 3. Cautious catch-all: any OTHER string field whose key is not in
    //    the deny-list and whose value looks like a real description
    //    (multi-word / mixed-case / alphanumeric — not a short
    //    category token). Sorted by descending length so we prefer
    //    the most descriptive value when several exist.
    const candidates: { key: string; value: string }[] = [];
    for (const [rawKey, rawVal] of Object.entries(it)) {
      const lk = rawKey.toLowerCase();
      if (ITEM_DENY_KEYS.has(lk)) continue;
      if (ITEM_TRUE_DESCRIPTION_KEYS.includes(rawKey)) continue;
      if (ITEM_NAME_KEYS.includes(rawKey)) continue;
      if (isLikelyDescription(rawVal)) {
        candidates.push({ key: rawKey, value: (rawVal as string).trim() });
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.value.length - a.value.length);
      return candidates[0].value;
    }
  }
  // 4. Job-level description (fallback so the customer at least sees the
  //    job's overall description rather than a generic placeholder).
  if (isUsableString(jobDescription)) return jobDescription.trim();
  // 5. Placeholder fallback when no recognisable description field exists.
  return `Item ${idx + 1}`;
};



// Optional quantity prefix — many sites display items as "3 Pillar Plate".
const getItemQuantity = (it: any): number | null => {
  if (!it || typeof it !== 'object') return null;
  for (const k of ['quantity', 'qty', 'count', 'pieces']) {
    const v = it[k];
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
};






const CustomerJobDetailsView: React.FC<Props> = ({ job, onBack }) => {
  const [loading, setLoading] = useState(false);
  const [stages, setStages] = useState<StageEvent[]>([]);
  const [quality, setQuality] = useState<QualityRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'items' | 'history' | 'notes'>('items');

  // Reset to Items tab and scroll to top whenever a new job is opened
  useEffect(() => {
    setActiveTab('items');
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [job.id]);


  // ---------------------------------------------------------------
  // Load item-status-change events from the `activity_logs` table.
  //
  // This matches the canonical data source used by the original RN
  // customer portal. Each `ITEM_STATUS_CHANGED` row carries the
  // following metadata fields we care about:
  //   - jobId            -> the job UUID
  //   - jobNumber        -> human job number (e.g. "160085")
  //   - itemId           -> per-item UUID (used for grouping)
  //   - itemDescription  -> resolved description (used for grouping +
  //                          display when itemId is missing)
  //   - oldStatus        -> stage before the change (e.g. "pending")
  //   - newStatus        -> stage after the change  (e.g. "workshop")
  //
  // We intentionally do NOT show JOB_CREATED / JOB_ARCHIVED rows —
  // the customer-facing history is focused on the 5-step production
  // journey (Workshop -> Acid -> Galva -> Finishing -> Ready).
  //
  // We also load `quality_control` (still used by the Notes tab).
  // ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    // Map an activity_logs row into our StageEvent shape. The
    // activity_logs `created_at` column is the timestamp the operator
    // pushed the status change in the admin app, so we use it as the
    // event timestamp.
    const mapActivityRow = (row: any): StageEvent => {
      const md = (row?.metadata && typeof row.metadata === 'object') ? row.metadata : {};
      // metadata may be stored as JSON text by some writers
      let meta: any = md;
      if (typeof row?.metadata === 'string') {
        try { meta = JSON.parse(row.metadata); } catch { meta = {}; }
      }
      return {
        id: String(row?.id ?? `${row?.created_at}-${meta?.itemId ?? meta?.itemDescription ?? Math.random()}`),
        job_id: meta?.jobId ?? row?.job_id ?? null,
        job_number: meta?.jobNumber ?? row?.job_number ?? null,
        item_id: meta?.itemId ?? meta?.item_id ?? null,
        item_name: meta?.itemDescription ?? meta?.item_description ?? meta?.itemName ?? null,
        from_stage: meta?.oldStatus ?? meta?.old_status ?? meta?.fromStatus ?? meta?.from_status ?? null,
        to_stage: meta?.newStatus ?? meta?.new_status ?? meta?.toStatus ?? meta?.to_status ?? null,
        stage: meta?.newStatus ?? meta?.new_status ?? null,
        status: meta?.newStatus ?? meta?.new_status ?? null,
        updated_at: row?.created_at ?? row?.createdAt ?? null,
        created_at: row?.created_at ?? row?.createdAt ?? null,
        notes: meta?.notes ?? meta?.note ?? null,
      };
    };

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // 1) Activity logs (item status changes) — primary source for the
        // History tab. We filter on metadata->>jobId because that's how
        // the operations tooling stores the link. We also try a fallback
        // where activity_logs has a top-level job_id column.

        // Primary: metadata->>jobId
        const aRes = await supabase
          .from('activity_logs')
          .select('*')
          .eq('action_type', 'ITEM_STATUS_CHANGED')
          .filter('metadata->>jobId', 'eq', job.id)
          .order('created_at', { ascending: true });

        let activityRows: any[] = [];
        if (!aRes.error && Array.isArray(aRes.data)) {
          activityRows = aRes.data;
        }

        // Fallback A: filter by metadata->>jobNumber (some writers only set this)
        if (activityRows.length === 0 && (job as any).job_number) {
          const aRes2 = await supabase
            .from('activity_logs')
            .select('*')
            .eq('action_type', 'ITEM_STATUS_CHANGED')
            .filter('metadata->>jobNumber', 'eq', String((job as any).job_number))
            .order('created_at', { ascending: true });
          if (!aRes2.error && Array.isArray(aRes2.data)) {
            activityRows = aRes2.data;
          }
        }

        // Fallback B: legacy top-level job_id column
        if (activityRows.length === 0) {
          const aRes3 = await supabase
            .from('activity_logs')
            .select('*')
            .eq('action_type', 'ITEM_STATUS_CHANGED')
            .eq('job_id', job.id)
            .order('created_at', { ascending: true });
          if (!aRes3.error && Array.isArray(aRes3.data) && aRes3.data.length > 0) {
            activityRows = aRes3.data;
          }
        }

        const events = activityRows.map(mapActivityRow);

        // 2) Quality control records (for the Notes tab) — keep the
        // existing snake_case-first-then-camelCase fallback.
        const qcSnake = await supabase
          .from('quality_control').select('*').eq('job_id', job.id)
          .order('created_at', { ascending: true });
        let qcRows: any[] = [];
        if (!qcSnake.error && Array.isArray(qcSnake.data)) {
          qcRows = qcSnake.data;
        } else {
          const qcCamel = await supabase
            .from('quality_control').select('*').eq('jobId', job.id)
            .order('createdAt', { ascending: true });
          qcRows = (qcCamel.data as any[]) || [];
        }

        if (cancelled) return;
        setStages(events);
        setQuality(normalizeRows(qcRows) as QualityRecord[]);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load job details');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [job.id]);


  // Realtime: refresh history when new ITEM_STATUS_CHANGED rows arrive.
  useEffect(() => {
    const channel = supabase
      .channel(`job-activity-${job.id}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'activity_logs',
      }, (payload: any) => {
        const row = payload.new;
        if (!row || row.action_type !== 'ITEM_STATUS_CHANGED') return;
        let meta: any = row.metadata;
        if (typeof meta === 'string') {
          try { meta = JSON.parse(meta); } catch { meta = {}; }
        }
        const rowJobId = meta?.jobId ?? row?.job_id;
        if (rowJobId && String(rowJobId) === String(job.id)) {
          // Re-fetch the full list (simpler + correct ordering)
          supabase
            .from('activity_logs')
            .select('*')
            .eq('action_type', 'ITEM_STATUS_CHANGED')
            .filter('metadata->>jobId', 'eq', job.id)
            .order('created_at', { ascending: true })
            .then(({ data }) => {
              if (Array.isArray(data)) {
                const mapped: StageEvent[] = data.map((r: any) => {
                  let m: any = r?.metadata;
                  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = {}; } }
                  return {
                    id: String(r?.id ?? `${r?.created_at}-${m?.itemId ?? Math.random()}`),
                    job_id: m?.jobId ?? r?.job_id ?? null,
                    job_number: m?.jobNumber ?? null,
                    item_id: m?.itemId ?? null,
                    item_name: m?.itemDescription ?? null,
                    from_stage: m?.oldStatus ?? null,
                    to_stage: m?.newStatus ?? null,
                    stage: m?.newStatus ?? null,
                    status: m?.newStatus ?? null,
                    updated_at: r?.created_at ?? null,
                    created_at: r?.created_at ?? null,
                    notes: m?.notes ?? null,
                  };
                });
                setStages(mapped);
              }
            });
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [job.id]);


  // Build a lookup from the job's items array so we can resolve human-readable
  // descriptions for stage-tracking rows that only carry item_id (a UUID).
  const itemNameById = useMemo(() => {
    const map: Record<string, string> = {};
    const jobItems = getJobItems(job);
    const jobDesc = (job as any)?.description as string | null | undefined;
    if (Array.isArray(jobItems)) {
      jobItems.forEach((it, idx) => {
        const desc = resolveItemDescription(it, idx, jobDesc);
        if (it?.id) map[String(it.id)] = desc;
        if (it?.itemId) map[String(it.itemId)] = desc;
        if (it?.item_id) map[String(it.item_id)] = desc;
      });
    }
    return map;
  }, [job]);

  const resolveItemName = useCallback((rec: { item_id?: string | null; item_name?: string | null; id: string }) => {
    // 1. Activity log already gives us the resolved description in metadata.itemDescription
    if (rec.item_name && rec.item_name.length > 3 && !UUID_RE.test(rec.item_name)) {
      return rec.item_name;
    }
    if (rec.item_id && itemNameById[rec.item_id]) return itemNameById[rec.item_id];
    if (rec.item_name && itemNameById[rec.item_name]) return itemNameById[rec.item_name];
    const jobDesc = (job as any)?.description as string | null | undefined;
    if (isUsableString(jobDesc)) return jobDesc.trim();
    return 'Item';
  }, [itemNameById, job]);

  // Group stage records into items, keyed by item_id when available
  // and falling back to the resolved description.
  const itemsJourney = useMemo(() => {
    const byItem: Record<string, { id: string; name: string; events: StageEvent[] }> = {};
    for (const s of stages) {
      const groupKey = s.item_id || (s.item_name ? `name:${s.item_name}` : `row:${s.id}`);
      const name = resolveItemName(s);
      if (!byItem[groupKey]) byItem[groupKey] = { id: groupKey, name, events: [] };
      else if (byItem[groupKey].name === 'Item' && name !== 'Item') byItem[groupKey].name = name;
      byItem[groupKey].events.push(s);
    }
    for (const k of Object.keys(byItem)) {
      byItem[k].events.sort((a, b) =>
        new Date(a.updated_at || a.created_at || 0).getTime() -
        new Date(b.updated_at || b.created_at || 0).getTime()
      );
    }
    return Object.values(byItem);
  }, [stages, resolveItemName]);



  // Use the items array from the job itself if no stage tracking data exists,
  // so the Items tab still shows individual line items.
  const itemsList = useMemo(() => {
    const jobItems = getJobItems(job);
    const jobDesc = (job as any)?.description as string | null | undefined;
    if (Array.isArray(jobItems) && jobItems.length > 0) {
      return jobItems.map((it, idx) => {
        const baseName = resolveItemDescription(it, idx, jobDesc);
        const qty = getItemQuantity(it);
        // Match the RN portal convention: prefix the description with the
        // quantity when it's > 1, e.g. "2 Gratings Fbar 100 - 50 - 580 x 580".
        const name = qty != null && qty > 1 && !/^\d+\s/.test(baseName)
          ? `${qty} ${baseName}` : baseName;
        const weight = parseFloat(String(it?.weightKg ?? it?.weight ?? '0')) || 0;
        const id = it?.id || it?.itemId || it?.item_id || `item-${idx}`;
        // Find the latest stage for this item if available
        const matched = itemsJourney.find(
          (j) => j.id === id || j.name === name || j.id === name,
        );
        const last = matched?.events[matched.events.length - 1];
        const stageRaw = last?.stage || last?.status || (it?.status as string | undefined) || job?.status || null;
        return {
          id, name, weight,
          stageRaw,
          quantity: qty,
          events: matched?.events ?? [],
        };
      });
    }
    // Fallback: derive items from stage tracking
    return itemsJourney.map((j, idx) => {
      const last = j.events[j.events.length - 1];
      return {
        id: j.id,
        name: j.name && j.name !== 'Item' ? j.name : `Item ${idx + 1}`,
        weight: 0,
        stageRaw: last?.stage || last?.status || job?.status || null,
        quantity: null as number | null,
        events: j.events,
      };
    });
  }, [job, itemsJourney]);




  const completed = isCompleted(job.status);
  const totalItems = getJobItems(job).length || job.total_items || itemsList.length || 0;
  const totalWeight = getJobWeight(job);
  const createdRef = job.created_at;
  const completedRef = job.updated_at || job.created_at;

  // Resolve the dates we want to surface in the summary card. Mirrors the
  // logic in JobCard so the details screen and the list card are
  // consistent:
  //   - tentativeDelivery: planned delivery date set during Planning. The
  //     customer-jobs edge function exposes this as `delivery_date`. In
  //     production it's sourced from the job's `production_finishing_date`
  //     column. We fall back to the legacy `estimated_completion` for
  //     older rows that pre-date that column.
  //   - deliveredDate: actual physical delivery / shipment date. The edge
  //     function exposes this as `delivered_date` (sourced from the job's
  //     `delivered_at` column, populated when ops marks the job as
  //     shipped/delivered). Fall back to updated_at as a last resort so
  //     the summary card never shows a blank "Delivered" value for a
  //     terminal job.
  const tentativeDelivery =
    (job as any).delivery_date ||
    (job as any).production_finishing_date ||
    (job as any).estimated_completion ||
    null;
  const deliveredDate =
    (job as any).delivered_date ||
    (job as any).delivered_at ||
    completedRef;

  // Operator-entered free-text notes. Sourced via the shared
  // resolveJobNotes helper so we read `notes`, `job_notes`, AND
  // `jobNotes` (snake/camel) for resilience and trim whitespace before
  // deciding whether to render the Notes callout panel.
  const notesText = resolveJobNotes(job);
  const hasNotes = notesText.length > 0;

  // The customer-contact / drop-off employee name lives inside the
  // free-text notes ("Brought by: John Doe", "Contact: John", etc.) —
  // there is no dedicated column for it in production. Parsed by
  // extractContactName so we can show it as a first-class field in the
  // summary card.
  const contactName = extractContactName(notesText || (job as any).notes);


  const totalUpdates = stages.length;
  const itemsWithHistory = itemsJourney.length;


  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      {/* Header */}
      <div className="bg-[#1a1a4e] text-white px-4 sm:px-6 lg:px-8 pt-5 pb-5 flex items-center gap-3 flex-shrink-0 shadow-md">
        <button
          onClick={onBack}
          className="w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors flex-shrink-0"
          aria-label="Back"
        >
          <ArrowLeft className="w-4 h-4 text-white" />
        </button>
        <h2 className="font-bold text-base flex-1 text-center pr-9">
          {completed ? 'Completed Job Details' : 'Job Details'}
        </h2>
      </div>

      <div className="flex-1 max-w-3xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-10">
          {/* Top job summary card */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 mb-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <FileText className="w-6 h-6 text-[#1a1a4e]" strokeWidth={2.2} />
                <span className="text-[#1a1a4e] font-extrabold text-xl">
                  {job.job_number || job.id.slice(0, 8)}
                </span>
              </div>
              <StatusPill job={job} />

            </div>

            <div className="bg-slate-50 rounded-xl grid grid-cols-3 divide-x divide-slate-200">
              <Stat icon={<Box className="w-4 h-4 text-slate-500" />} value={totalItems} label="Items" />
              <Stat
                icon={<Package className="w-4 h-4 text-slate-500" />}
                value={totalWeight.toFixed(1)}
                label="Total kg"
              />
              <Stat
                icon={<CalendarIcon className="w-4 h-4 text-slate-500" />}
                value={formatShortDate(completed ? deliveredDate : createdRef)}
                label={completed ? 'Delivered' : 'Created'}
              />
            </div>

            {/* Extra info rows: brought-by contact, expected delivery,
                delivered date. These show conditionally so jobs that
                don't have these fields populated yet keep the same
                compact layout. */}
            {(contactName || (!completed && tentativeDelivery) || completed) && (
              <div className="mt-3 space-y-1.5">
                {contactName && (
                  <div className="flex items-center gap-2 text-sm text-slate-700">
                    <User className="w-4 h-4 text-[#1a1a4e]" />
                    <span>Brought by: <span className="font-semibold text-slate-900">{contactName}</span></span>
                  </div>
                )}
                {!completed && tentativeDelivery && (
                  <div className="flex items-center gap-2 text-sm text-amber-700 font-semibold">
                    <Truck className="w-4 h-4 text-amber-600" />
                    <span>Expected Delivery: {formatLongDate(tentativeDelivery)}</span>
                  </div>
                )}
                {completed && (
                  <div className="flex items-center gap-2 text-sm text-emerald-700 font-semibold">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>Delivered: {formatLongDate(deliveredDate)}</span>
                  </div>
                )}
              </div>
            )}

          </div>



          {/* Tabs */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-1 mb-4 grid grid-cols-3 gap-1">
            <TabButton
              active={activeTab === 'items'}
              onClick={() => setActiveTab('items')}
              icon={<Box className="w-4 h-4" />}
              label="Items"
              count={totalItems}
            />
            <TabButton
              active={activeTab === 'history'}
              onClick={() => setActiveTab('history')}
              icon={<HistoryIcon className="w-4 h-4" />}
              label="History"
              count={totalUpdates}
            />
            <TabButton
              active={activeTab === 'notes'}
              onClick={() => setActiveTab('notes')}
              icon={<MessageSquare className="w-4 h-4" />}
              label="Notes"
            />
          </div>

          {error && (
            <div className="text-xs bg-red-50 text-red-700 border border-red-200 rounded-md px-3 py-2 mb-3">
              {error}
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
            </div>
          )}

          {!loading && activeTab === 'items' && (
            <div className="space-y-3">
              {/* Soft yellow callout with the operator-entered notes.
                  Only renders when notesText is a non-empty string
                  (resolveJobNotes already trims whitespace). Sits above
                  the items list so the customer sees any special
                  instructions before the per-item details. */}
              {hasNotes && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <StickyNote className="w-4 h-4 text-amber-700" />
                    <p className="text-[11px] font-bold uppercase tracking-wide text-amber-800">
                      Notes
                    </p>
                  </div>
                  <p className="text-sm text-amber-900 whitespace-pre-wrap leading-relaxed">
                    {notesText}
                  </p>
                </div>
              )}

              {/* Two-row date strip: Tentative / Delivered. Both rows
                  always render (with an em-dash placeholder when the
                  underlying date isn't set yet) so the strip stays
                  rectangular and easy to scan. Mauritius-timezone
                  formatted via formatLongDate above. */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm divide-y divide-slate-100">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <div className="flex items-center gap-2 text-xs text-slate-500 font-semibold uppercase tracking-wide">
                    <Truck className="w-3.5 h-3.5 text-amber-600" />
                    Tentative
                  </div>
                  <span className={`text-sm font-semibold ${tentativeDelivery ? 'text-slate-900' : 'text-slate-400'}`}>
                    {tentativeDelivery ? formatLongDate(tentativeDelivery) : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5">
                  <div className="flex items-center gap-2 text-xs text-slate-500 font-semibold uppercase tracking-wide">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    Delivered
                  </div>
                  <span className={`text-sm font-semibold ${(job as any).delivered_date || (job as any).delivered_at ? 'text-slate-900' : 'text-slate-400'}`}>
                    {((job as any).delivered_date || (job as any).delivered_at)
                      ? formatLongDate(deliveredDate)
                      : '—'}
                  </span>
                </div>
              </div>

              <ItemsTab items={itemsList} completed={completed} />
            </div>
          )}


          {!loading && activeTab === 'history' && (
            <HistoryTab
              jobNumber={job.job_number || job.id.slice(0, 8)}
              totalUpdates={totalUpdates}
              itemsCount={itemsWithHistory}
              itemsJourney={itemsJourney}
            />
          )}

          {!loading && activeTab === 'notes' && (
            <NotesTab description={job.description} quality={quality} />
          )}
      </div>
    </div>
  );
};


/* ---------- Sub-components ---------- */

const StatusPill: React.FC<{ job: Job }> = ({ job }) => {
  // Drive both the colour AND the text label from the EFFECTIVE stage,
  // i.e. from items[].status — not from the loose job.status string.
  // This keeps the details summary in lockstep with the JobCard list.
  const stage = deriveEffectiveStage(job);
  const style = STAGE_STYLES[stage];
  const label = formatStatus(job);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full ${style.badgeBg} ${style.badgeText}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {label}
    </span>
  );
};


const Stat: React.FC<{ icon: React.ReactNode; value: React.ReactNode; label: string }> = ({ icon, value, label }) => (
  <div className="flex flex-col items-center justify-center py-3 px-2">
    <div className="mb-1">{icon}</div>
    <p className="text-lg font-extrabold text-slate-900 leading-tight">{value}</p>
    <p className="text-[11px] text-slate-500 mt-0.5">{label}</p>
  </div>
);

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}> = ({ active, onClick, icon, label, count }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-semibold transition-colors
      ${active ? 'bg-[#eeeaff] text-[#1a1a4e]' : 'text-slate-500 hover:bg-slate-50'}`}
  >
    {icon}
    <span>{label}</span>
    {count !== undefined && count > 0 && (
      <span className={`inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full text-[10px] font-bold
        ${active ? 'bg-[#1a1a4e] text-white' : 'bg-slate-200 text-slate-600'}`}>
        {count}
      </span>
    )}
  </button>
);

/* ---------- Items Tab ---------- */

interface ItemRow {
  id: string;
  name: string;
  weight: number;
  stageRaw?: string | null;
  quantity?: number | null;
  events: StageEvent[];
}

const ItemsTab: React.FC<{ items: ItemRow[]; completed: boolean }> = ({ items, completed }) => {
  if (items.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
        <Box className="w-10 h-10 mx-auto text-slate-300" />
        <p className="mt-3 text-sm text-slate-500">No items recorded for this job.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {items.map((it, idx) => {
        const stage = classifyStage(it.stageRaw);
        const style = STAGE_STYLES[stage];
        const stageLabel = completed ? 'Completed' : style.label;
        const stageStyleObj = completed ? STAGE_STYLES.ready : style;
        return (
          <div key={it.id} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="inline-flex items-center justify-center bg-[#1a1a4e] text-white text-xs font-bold px-2.5 py-1 rounded-md">
                #{idx + 1}
              </span>
              <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full ${stageStyleObj.badgeBg} ${stageStyleObj.badgeText}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${stageStyleObj.dot}`} />
                {stageLabel}
              </span>
            </div>
            <p className="text-sm text-slate-800 mb-3 leading-snug">{it.name}</p>
            <div className="bg-slate-50 rounded-lg px-3 py-2 space-y-1">
              {it.quantity != null && (
                <div className="flex items-center gap-2 text-xs text-slate-700">
                  <Box className="w-3.5 h-3.5 text-slate-400" />
                  <span>Quantity: <span className="font-semibold text-slate-900">{it.quantity}</span></span>
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-slate-700">
                <Package className="w-3.5 h-3.5 text-slate-400" />
                <span>Weight: <span className="font-semibold text-slate-900">{it.weight.toFixed(2)} kg</span></span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* ---------- History Tab ---------- */

const HistoryTab: React.FC<{
  jobNumber: string;
  totalUpdates: number;
  itemsCount: number;
  itemsJourney: { id: string; name: string; events: StageEvent[] }[];
}> = ({ jobNumber, totalUpdates, itemsCount, itemsJourney }) => {
  if (totalUpdates === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
        <HistoryIcon className="w-10 h-10 mx-auto text-slate-300" />
        <p className="mt-3 text-sm text-slate-500">No status updates yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary card */}
      <div className="bg-[#1a1a4e] text-white rounded-xl p-4 flex items-center gap-3 shadow-sm">
        <FileText className="w-5 h-5 text-white flex-shrink-0" strokeWidth={2.2} />
        <div className="flex-1 min-w-0">
          <p className="font-extrabold text-lg leading-tight">{jobNumber}</p>
          <p className="text-xs text-white/70">{totalUpdates} updates across {itemsCount} item{itemsCount === 1 ? '' : 's'}</p>
        </div>
        <span className="inline-flex items-center justify-center min-w-[32px] h-[26px] px-2 rounded-full bg-white/15 text-white text-xs font-bold">
          {totalUpdates}
        </span>
      </div>

      {/* Per-item history */}
      {itemsJourney.map((item) => (
        <ItemHistoryCard key={item.id} item={item} />
      ))}
    </div>
  );
};

// Stages displayed in the legend at the top of each Item History card
// (Workshop → Acid → Galva → Finishing → Ready). Matches the original RN
// portal's design — it's a static colour legend so the customer can decode
// the stage chips in the per-event timeline below it. We do NOT show
// pending here (it's the implicit starting state for every item).
const LEGEND_STAGES: StageKey[] = ['workshop', 'acid', 'galva', 'finishing', 'ready'];

const ItemHistoryCard: React.FC<{
  item: { id: string; name: string; events: StageEvent[] };
}> = ({ item }) => {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="bg-[#1a1a4e] text-white px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-md bg-amber-400 flex items-center justify-center flex-shrink-0">
            <Box className="w-4 h-4 text-amber-900" />
          </div>
          <p className="font-bold text-sm leading-snug line-clamp-2">{item.name}</p>
        </div>
        <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-full bg-amber-400 text-amber-900 text-[11px] font-bold flex-shrink-0">
          {item.events.length} step{item.events.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Static colour legend so the customer can decode the stage chips
          shown in the per-event timeline below. Mirrors the original RN
          portal layout. */}
      <div className="px-4 py-3 bg-slate-50/60">
        <div className="flex items-center gap-x-4 gap-y-1.5 flex-wrap">
          {LEGEND_STAGES.map((k) => {
            const s = STAGE_STYLES[k];
            return (
              <span key={k} className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                <span className={`w-2.5 h-2.5 rounded-full ${s.dot}`} />
                <span className={s.badgeText}>{s.label}</span>
              </span>
            );
          })}
        </div>
      </div>

      {/* Timeline of recorded stage transitions for this item.
          Layout mirrors the original RN portal: a vertical list of
          violet-circled GitBranch icons, with a dashed connector line
          drawn between successive icons and an event card to the right
          showing the timestamp and From → To stage chips. */}
      <div className="px-4 pt-2 pb-4">
        {item.events.length === 0 ? (
          <p className="text-xs text-slate-500 text-center py-4">
            No stage updates recorded yet.
          </p>
        ) : (
          <ol className="relative">
            {item.events.map((ev, idx) => {
              const prev = idx > 0 ? item.events[idx - 1] : null;
              const fromRaw = ev.from_stage || prev?.to_stage || prev?.stage || prev?.status || (idx === 0 ? 'pending' : null);
              const toRaw = ev.to_stage || ev.stage || ev.status;
              const fromStyle = stageStyleFor(fromRaw);
              const toStyle = stageStyleFor(toRaw);
              const isLast = idx === item.events.length - 1;
              return (
                <li key={ev.id} className="relative flex items-start gap-3 pb-3 last:pb-0">
                  {/* Dashed connector to the next event */}
                  {!isLast && (
                    <span
                      aria-hidden
                      className="absolute left-[18px] top-9 bottom-0 w-px border-l-2 border-dashed border-violet-200"
                    />
                  )}
                  {/* Icon bubble */}
                  <div className="relative z-10 w-9 h-9 rounded-full bg-violet-100 flex items-center justify-center flex-shrink-0">
                    <GitBranch className="w-4 h-4 text-violet-600" />
                  </div>
                  {/* Event card */}
                  <div className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg px-3 py-2.5 shadow-sm">
                    <p className="text-[12px] text-slate-700 mb-2 font-medium">
                      {formatLongDate(ev.updated_at || ev.created_at)}
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${fromStyle.badgeBg} ${fromStyle.badgeText}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${fromStyle.dot}`} />
                        {fromStyle.label}
                      </span>
                      <ArrowRight className="w-3 h-3 text-slate-400" />
                      <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${toStyle.badgeBg} ${toStyle.badgeText}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${toStyle.dot}`} />
                        {toStyle.label}
                      </span>
                    </div>
                    {ev.notes && (
                      <p className="text-xs text-slate-600 mt-1.5">{ev.notes}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
};





/* ---------- Notes Tab ---------- */

const NotesTab: React.FC<{
  description?: string | null;
  quality: QualityRecord[];
}> = ({ description, quality }) => {
  if (!description && quality.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
        <MessageSquare className="w-10 h-10 mx-auto text-slate-300" />
        <p className="mt-3 text-sm text-slate-500">No notes for this job.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {description && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Job Description
          </p>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{description}</p>
        </div>
      )}
      {quality.map((q) => {
        const r = (q.result || '').toLowerCase();
        const tone = r.includes('pass') || r.includes('ok')
          ? 'bg-emerald-100 text-emerald-800'
          : r.includes('fail') || r.includes('reject')
          ? 'bg-rose-100 text-rose-800'
          : 'bg-slate-100 text-slate-700';
        return (
          <div key={q.id} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className={`inline-flex text-[11px] font-medium px-2 py-0.5 rounded capitalize ${tone}`}>
                {q.result || 'waiting'}
              </span>

              <span className="text-[11px] text-slate-400">
                {formatLongDate(q.inspected_at || q.created_at)}
              </span>
            </div>
            {q.inspector && (
              <p className="text-[11px] text-slate-500 mb-1">Inspector: {q.inspector}</p>
            )}
            {q.notes && (
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{q.notes}</p>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default CustomerJobDetailsView;
