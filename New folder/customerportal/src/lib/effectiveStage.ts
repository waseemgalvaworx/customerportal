// =============================================================================
// effectiveStage.ts — derive a job's *real* production stage from its items.
// =============================================================================
//
// The customer portal's Active list shows three high-level statuses:
//   - "Waiting"     — all items are still in Pending (nothing started yet)
//   - "In Progress" — at least one item has moved off Pending but the job
//                     isn't finished (workshop / acid / galva / finishing)
//   - "Ready"       — every item has reached Ready
//
// The plain `job.status` column is unreliable for this — operators don't
// always update it as items advance. The CANONICAL source of truth is the
// per-item `status` recorded inside the `items` JSON array on each job
// (mirrored from the `item_stage_tracking` table by ops tooling).
//
// `deriveEffectiveStage(job)` returns the StageKey that best summarises
// where the job sits in the pipeline:
//
//   - 'pending'   if EVERY item is still pending
//                 → label "Waiting", amber palette
//   - 'ready'     if EVERY item has reached Ready (or a terminal status
//                 like Shipped / Delivered / Completed)
//                 → label "Ready", emerald palette
//   - otherwise   the FURTHEST-ADVANCED in-progress stage any item has
//                 reached (workshop ⊂ acid ⊂ galva ⊂ finishing) — this
//                 is what drives the card's accent colour so a customer
//                 can see at a glance how deep into production the job is
//                 → label "In Progress" with that stage's palette
//
// We fall back to `classifyStage(job.status)` when the job has no items
// array (legacy data, or completed_jobs reconstructions where the rows
// weren't grouped with stage info).
// =============================================================================

import { classifyStage, STAGE_ORDER, type StageKey } from './stageColors';

// Same loose schema we accept elsewhere — different writers populate
// different keys. We resolve the FIRST non-empty array we find.
const ITEMS_ARRAY_KEYS = [
  'items', 'lineItems', 'line_items',
  'jobItems', 'job_items', 'parts', 'products',
];

const getItemsArray = (job: any): any[] => {
  if (!job || typeof job !== 'object') return [];
  for (const k of ITEMS_ARRAY_KEYS) {
    const v = job[k];
    if (Array.isArray(v) && v.length > 0) return v;
    if (typeof v === 'string' && v.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch { /* noop */ }
    }
  }
  return [];
};

// Pull a `status` (or close synonym) off a single line item. Different
// writers use slightly different field names.
const getItemStatus = (it: any): string | null => {
  if (!it || typeof it !== 'object') return null;
  for (const k of ['status', 'stage', 'state', 'currentStatus', 'current_status', 'currentStage', 'current_stage']) {
    const v = it[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
};

// Active in-pipeline stages, ordered from earliest to latest. Used to
// pick the FURTHEST-ADVANCED stage among the job's items so the card
// colour reflects real progress (e.g. a job with 4 items in workshop
// and 1 item in galva is shown as "galva" purple — its leading edge).
const PIPELINE_ORDER: StageKey[] = ['workshop', 'acid', 'galva', 'finishing'];

// Treat these terminal job-level statuses as "ready" for colouring
// purposes. This covers completed_jobs reconstructions where the status
// is "shipped" / "delivered" / "archived" but there's no items array
// with per-item stage info.
const TERMINAL_AS_READY = new Set([
  'ready', 'complete', 'completed', 'done', 'finished',
  'shipped', 'delivered', 'archived', 'closed',
]);

export function deriveEffectiveStage(job: any): StageKey {
  const items = getItemsArray(job);

  // No items at all → fall back to the job-level status.
  if (items.length === 0) {
    const jobStage = classifyStage(job?.status);
    if (jobStage === 'other') {
      const lower = String(job?.status ?? '').toLowerCase().trim();
      if (TERMINAL_AS_READY.has(lower)) return 'ready';
    }
    return jobStage;
  }

  // Classify every item.
  const itemStages: StageKey[] = items.map((it) => {
    const raw = getItemStatus(it);
    return classifyStage(raw);
  });

  // 1. ALL pending → Waiting.
  if (itemStages.every((s) => s === 'pending' || s === 'other')) {
    return 'pending';
  }

  // 2. ALL ready → Ready.
  if (itemStages.every((s) => s === 'ready')) {
    return 'ready';
  }

  // 3. Otherwise, find the FURTHEST-ADVANCED in-pipeline stage any item
  //    has reached. We scan PIPELINE_ORDER backwards (finishing first).
  for (let i = PIPELINE_ORDER.length - 1; i >= 0; i--) {
    const stage = PIPELINE_ORDER[i];
    if (itemStages.includes(stage)) return stage;
  }

  // Defensive fallback: at least one item is past pending but none of
  // the recognised pipeline stages matched (e.g. a custom "in_progress"
  // string). Treat as workshop (the earliest in-progress stage).
  return 'workshop';
}

// Convenience: directly derive the user-facing label for the Active
// list. Mirrors the rules in JobCard.formatActiveStatus but driven by
// the effective stage rather than the raw job.status string.
export function deriveActiveStatusLabel(job: any): 'Waiting' | 'In Progress' | 'Ready' {
  const stage = deriveEffectiveStage(job);
  if (stage === 'pending') return 'Waiting';
  if (stage === 'ready') return 'Ready';
  return 'In Progress';
}

// Re-export for convenience so callers don't need a second import.
export { STAGE_ORDER };
export type { StageKey };
