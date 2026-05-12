import React from 'react';
import { FileText, Package, Box, Calendar, ChevronRight, Truck, User } from 'lucide-react';

import { extractContactName } from '@/lib/extractContactName';
import { type StageKey } from '@/lib/stageColors';
import { deriveEffectiveStage, deriveActiveStatusLabel } from '@/lib/effectiveStage';

export interface Job {
  id: string;
  job_number?: string | null;
  title?: string | null;
  description?: string | null;
  status: string;
  customer_id?: string | null;
  customer_name?: string | null;
  total_items?: number | null;
  completed_items?: number | null;
  total_weight?: number | null;
  weight?: number | null;
  // The shared backend stores per-job line items as a JSON array on the
  // `items` column. Each entry has { weightKg, ... }. We sum these as a
  // fallback when total_weight isn't pre-aggregated, matching the RN portal.
  items?: Array<{ weightKg?: string | number | null;[k: string]: any }> | null;
  // Free-text notes the operator typed when the job was created. This is
  // ALSO where the customer-contact name lives ("Brought by: John Doe"),
  // which we parse out via extractContactName(). There is no dedicated
  // `customer_contact_name` / `employee_name` column in production.
  // Some writers / edge-function payloads expose this as `job_notes`
  // (snake_case) or `jobNotes` (camelCase) instead, so we read all three
  // for resilience.
  notes?: string | null;
  job_notes?: string | null;
  jobNotes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  received_at?: string | null;
  estimated_completion?: string | null;
  // The PLANNED / EXPECTED delivery date.
  //
  // The customer-jobs edge function exposes this as `delivery_date`
  // (tentative). In production this is sourced from the job's
  // `production_finishing_date` column (set when the job enters the
  // Planning stage in the Job Management system). We accept both keys
  // plus the legacy `estimated_completion` as a final fallback.
  delivery_date?: string | null;
  production_finishing_date?: string | null;
  // The ACTUAL physical delivery / shipment timestamp.
  //
  // The customer-jobs edge function exposes this as `delivered_date`
  // (actual). In production this is sourced from the job's
  // `delivered_at` column, populated when ops marks the job as
  // shipped/delivered. Surfaced on History job cards as "Delivered".
  delivered_date?: string | null;
  delivered_at?: string | null;
  archived?: boolean | null;
  stage_breakdown?: Partial<Record<string, number>> | null;
}


interface JobCardProps {
  job: Job;
  onClick: (job: Job) => void;
  variant?: 'active' | 'history';
}

const PORTAL_TIMEZONE = 'Indian/Mauritius';

const formatDate = (d?: string | null) => {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-GB', {
      timeZone: PORTAL_TIMEZONE,
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return '—'; }
};


// Resolve the operator-entered free-text notes from whichever key the
// upstream writer used. Trim before returning so trailing whitespace
// doesn't trick callers into rendering an "empty" notes panel.
export const resolveJobNotes = (job: Job): string => {
  const raw = job.notes ?? job.job_notes ?? (job as any).jobNotes ?? null;
  if (typeof raw !== 'string') return '';
  return raw.trim();
};


// Total weight resolution order (matches the RN customer portal):
//   1. Use a server-aggregated `total_weight` / `weight` if present.
//   2. Otherwise, sum `weightKg` across the job's `items` array.
const getTotalWeightFromItems = (items: Job['items']): number => {
  if (!items || !Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    const w = parseFloat(String(item?.weightKg ?? '0'));
    return sum + (isFinite(w) ? w : 0);
  }, 0);
};

const getWeight = (job: Job): number => {
  const direct = job.total_weight ?? job.weight;
  const directNum = Number(direct);
  if (direct != null && isFinite(directNum) && directNum > 0) return directNum;
  return getTotalWeightFromItems(job.items);
};


// On the ACTIVE tab the original Customer Portal collapses the various
// in-process workshop stages into a single "In Progress" badge. Only
// Pending and Ready get their own dedicated labels. Crucially, the
// effective stage is derived from the JOB'S ITEMS — not from the loose
// `job.status` string, which operators don't always keep in sync as
// individual items move along the line.
//
// Rules (see deriveEffectiveStage / deriveActiveStatusLabel):
//   - all items still pending      -> "Waiting"
//   - all items at ready/terminal  -> "Ready"
//   - any item past pending        -> "In Progress"
//
// The card colour ALSO reflects the furthest-advanced item stage so the
// customer can see at a glance how deep into production the job is —
// even though the pill text is just "In Progress" until every item is
// Ready.
//
// On the HISTORY tab we use the actual terminal status label
// ("Completed", "Shipped", "Delivered", "Cancelled" …) since those jobs
// are no longer in the production pipeline.


// History-tab pill label.
//   - Match the explicit terminal status string when present.
//   - When the status string is non-terminal (e.g. "ready" / "done" /
//     "completed") but the job has a real delivered/shipped timestamp —
//     which is how this deployment classifies the job as history at all
//     (see CustomerPortal.isHistoryJob) — we surface "Delivered" /
//     "Shipped" so the pill matches the truck-icon line at the top of
//     the card and customers don't see a generic "Completed" for a job
//     that is in fact already out the door.
const formatHistoryStatus = (s: string | null | undefined, job?: Job): string => {
  const lower = (s || '').toLowerCase().trim();
  if (lower === 'shipped') return 'Shipped';
  if (lower === 'delivered') return 'Delivered';
  if (lower === 'cancelled' || lower === 'canceled') return 'Cancelled';
  if (lower === 'archived') return 'Archived';

  if (job) {
    const j = job as any;
    const hasDelivered =
      j.delivered_date || j.deliveredDate ||
      j.delivered_at || j.deliveredAt;
    if (hasDelivered) return 'Delivered';
    const hasShipped =
      j.shipped_date || j.shippedDate ||
      j.shipped_at || j.shippedAt;
    if (hasShipped) return 'Shipped';
  }

  return 'Completed';
};


const getItemCount = (job: Job): number => {
  // Prefer the server-aggregated total. Otherwise fall back to the length
  // of the embedded items[] JSON array, which is what the original RN
  // portal does and matches what customers expect to see on the card.
  const direct = job.total_items;
  if (direct != null && Number.isFinite(Number(direct)) && Number(direct) > 0) {
    return Number(direct);
  }
  if (Array.isArray(job.items)) return job.items.length;
  return 0;
};


// Per-stage card colour palette, ported from the original React Native
// Customer Portal. The whole card body picks up a soft tinted background
// + a saturated coloured left border + a matching pill, so customers can
// glance at the Active list and immediately see which production stage
// each job is in:
//
//   Pending    -> amber  (Waiting)
//   Workshop   -> blue   (In Progress)
//   Acid       -> rose   (In Progress)
//   Galva      -> violet (In Progress)
//   Finishing  -> pink   (In Progress)
//   Ready      -> emerald (Ready)
//
// History jobs always render in the muted emerald palette since they're
// completed regardless of which stage they finished in.
interface CardPalette {
  bg: string;       // card body background
  border: string;   // left accent border
  pillBg: string;   // status pill background
  pillText: string; // status pill text colour
  innerBg: string;  // inner stats panel background
}

const ACTIVE_PALETTES: Record<StageKey, CardPalette> = {
  pending:   { bg: 'bg-amber-50',   border: 'border-amber-400',   pillBg: 'bg-amber-500',   pillText: 'text-white', innerBg: 'bg-amber-100/40' },
  workshop:  { bg: 'bg-blue-50',    border: 'border-blue-500',    pillBg: 'bg-blue-600',    pillText: 'text-white', innerBg: 'bg-blue-100/40' },
  acid:      { bg: 'bg-rose-50',    border: 'border-rose-500',    pillBg: 'bg-rose-600',    pillText: 'text-white', innerBg: 'bg-rose-100/40' },
  galva:     { bg: 'bg-violet-50',  border: 'border-violet-500',  pillBg: 'bg-violet-600',  pillText: 'text-white', innerBg: 'bg-violet-100/40' },
  finishing: { bg: 'bg-pink-50',    border: 'border-pink-500',    pillBg: 'bg-pink-600',    pillText: 'text-white', innerBg: 'bg-pink-100/40' },
  ready:     { bg: 'bg-emerald-50', border: 'border-emerald-500', pillBg: 'bg-emerald-600', pillText: 'text-white', innerBg: 'bg-emerald-100/40' },
  other:     { bg: 'bg-slate-50',   border: 'border-slate-400',   pillBg: 'bg-slate-600',   pillText: 'text-white', innerBg: 'bg-slate-100/40' },
};

const HISTORY_PALETTE: CardPalette = {
  bg: 'bg-emerald-50/60',
  border: 'border-emerald-600',
  pillBg: 'bg-emerald-600',
  pillText: 'text-white',
  innerBg: 'bg-white/70',
};

const JobCard: React.FC<JobCardProps> = ({ job, onClick, variant = 'active' }) => {
  const weight = getWeight(job);
  const items = getItemCount(job);
  const isHistory = variant === 'history';

  // Resolve the dates we want to surface on the card:
  // - Active: "Received" (always) + optional "Delivery" if a tentative
  //   delivery_date has been set (delivery_date from the edge function,
  //   or the legacy production_finishing_date / estimated_completion).
  // - History: "Delivered" date — prefer the explicit delivered_date /
  //   delivered_at, otherwise fall back to updated_at (the moment the job
  //   transitioned to its terminal state) and finally received/created.
  const tentativeDelivery =
    job.delivery_date ||
    job.production_finishing_date ||
    job.estimated_completion ||
    null;
  const deliveredDate =
    job.delivered_date ||
    job.delivered_at ||
    job.updated_at ||
    job.received_at ||
    job.created_at;
  const receivedDate = job.received_at || job.created_at;

  // Operator-entered free-text notes. May arrive under `notes`,
  // `job_notes`, or `jobNotes` depending on which writer populated the
  // row. Trimmed by resolveJobNotes so whitespace-only strings don't
  // mislead callers.
  const notesText = resolveJobNotes(job);

  // The customer-contact / drop-off employee name lives inside the free
  // text `notes` field on the job ("Brought by: John Doe", "Contact: John",
  // etc.). We do NOT have a dedicated column for it in production. We
  // surface this name in a compact line under the Received date so the
  // customer can see who dropped the goods off without having to open
  // the details modal.
  //
  // Resolution strategy:
  //   1. Try the structured parser (`extractContactName`) — handles the
  //      common "Brought by:", "Driver:", "Contact:", … prefixes.
  //   2. If that returns nothing AND the raw notes are short / single-line,
  //      treat the whole notes string as the name. This is the real-world
  //      case in this deployment: operators often just type the contact's
  //      name directly into the notes box with no prefix at all (e.g.
  //      "John Doe", "Ashley", "M. Pillay"), and we still want that
  //      surfaced on the card.
  //   3. Cap the displayed string at ~40 chars so a long free-form note
  //      can't break the card layout.
  const looksLikePlainName = (s: string): boolean => {
    if (!s) return false;
    const trimmed = s.trim();
    if (trimmed.length === 0 || trimmed.length > 40) return false;
    // Single physical line only — multi-line notes are real notes, not a name.
    if (/[\r\n]/.test(trimmed)) return false;
    // Reject if it's mostly digits / punctuation (looks like a phone #
    // or order ref rather than a person).
    const letterCount = (trimmed.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    if (letterCount < 2) return false;
    return true;
  };

  const parsedContactName = extractContactName(notesText || job.notes);
  const contactName =
    parsedContactName ||
    (looksLikePlainName(notesText) ? notesText.trim() : null);


  // Pick the colour palette + status label. Active jobs are coloured by
  // the FURTHEST-ADVANCED item stage (derived from the items[] JSON
  // array, NOT the loose job.status string) so the customer can scan
  // the list and see at a glance where each job is in the pipeline.
  // History jobs use the muted emerald palette regardless.
  const stage = isHistory ? 'ready' : deriveEffectiveStage(job);
  const palette = isHistory ? HISTORY_PALETTE : (ACTIVE_PALETTES[stage] || ACTIVE_PALETTES.other);
  const statusLabel = isHistory ? formatHistoryStatus(job.status, job) : deriveActiveStatusLabel(job);



  return (
    <button
      type="button"
      onClick={() => onClick(job)}
      className={`group w-full text-left rounded-xl overflow-hidden border-l-4 ${palette.border} ${palette.bg}
        hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 shadow-sm`}
    >
      {/* Top row: job number + status pill (with optional notes badge) */}
      <div className="flex items-start justify-between px-4 pt-4 pb-2 gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className={`w-8 h-8 rounded-full ${palette.pillBg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
            <FileText className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <span className="block text-[#1a1a4e] font-bold text-base truncate">
              {job.job_number || job.id.slice(0, 8)}
            </span>
            {/* Compact delivery line directly under the job number.
                - Active jobs show the TENTATIVE delivery date when set.
                - History jobs show the ACTUAL delivered date. */}
            {isHistory ? (
              <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                <Truck className="w-3 h-3" />
                Delivered: <span className="text-slate-800">{formatDate(deliveredDate)}</span>
              </span>
            ) : tentativeDelivery ? (
              <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                <Truck className="w-3 h-3" />
                Delivery: <span className="text-slate-800">{formatDate(tentativeDelivery)}</span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`text-xs font-semibold px-3 py-1 rounded-full ${palette.pillBg} ${palette.pillText}`}>
            {statusLabel}
          </span>
        </div>
      </div>


      {/* Middle: weight + items */}
      <div className={`mx-4 mb-3 ${palette.innerBg} bg-white/70 rounded-lg px-3 py-2.5 space-y-1.5`}>
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <Package className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <span>Total Weight: <span className="font-bold text-slate-900">{weight.toFixed(2)} kg</span></span>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <Box className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <span>Items: <span className="font-bold text-slate-900">{items}</span></span>
        </div>
      </div>

      {/* Bottom: Received date for active jobs (history shows Delivered up
          top), with the operator-provided contact name (parsed out of the
          free-text notes — "Brought by: John Doe", "Driver: …", etc.)
          rendered immediately under the date so the customer can see at a
          glance who dropped the goods off without opening the details
          modal. The card is already clickable for the full notes. */}
      {!isHistory && (
        <div className="px-4 pb-2 pt-2 border-t border-slate-200/60 space-y-1">
          <div className="flex items-center gap-2">
            <Calendar className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
            <span className="text-xs text-slate-500">
              Received: {formatDate(receivedDate)}
            </span>
          </div>
          {contactName && (
            <div className="flex items-center gap-2">
              <User className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
              <span className="text-xs text-slate-600 truncate">
                <span className="text-slate-400">Brought by:</span>{' '}
                <span className="font-semibold text-slate-700">{contactName}</span>
              </span>
            </div>
          )}

        </div>
      )}


      {/* Footer: tap for details */}
      <div className="px-4 pb-3 pt-2 flex items-center justify-center gap-1 text-xs text-slate-500 group-hover:text-[#1a1a4e] transition-colors">
        <span>Tap for details</span>
        <ChevronRight className="w-3.5 h-3.5" />
      </div>
    </button>
  );
};

export default JobCard;
