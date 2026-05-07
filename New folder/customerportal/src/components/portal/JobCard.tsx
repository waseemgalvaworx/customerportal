import React from 'react';
import { FileText, Package, Box, Calendar, ChevronRight } from 'lucide-react';

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
  created_at?: string | null;
  updated_at?: string | null;
  received_at?: string | null;
  estimated_completion?: string | null;
  archived?: boolean | null;
  stage_breakdown?: Partial<Record<string, number>> | null;
}


interface JobCardProps {
  job: Job;
  onClick: (job: Job) => void;
  variant?: 'active' | 'history';
}

const formatDate = (d?: string | null) => {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-GB', {
      timeZone: 'Indian/Mauritius',
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return '—'; }
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


const formatStatus = (s?: string | null) => {
  if (!s) return 'In Progress';
  const lower = s.toLowerCase();
  if (lower === 'in_progress' || lower === 'in progress' || lower === 'active') return 'In Progress';
  if (lower === 'ready') return 'Ready';
  if (lower === 'complete' || lower === 'completed' || lower === 'done') return 'Completed';
  if (lower === 'shipped') return 'Shipped';
  if (lower === 'delivered') return 'Delivered';
  if (lower === 'cancelled' || lower === 'canceled') return 'Cancelled';
  // Capitalize first letter
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
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

const JobCard: React.FC<JobCardProps> = ({ job, onClick, variant = 'active' }) => {
  const weight = getWeight(job);
  const items = getItemCount(job);
  const isHistory = variant === 'history';

  return (
    <button
      type="button"
      onClick={() => onClick(job)}
      className={`group w-full text-left rounded-xl overflow-hidden border-l-4 border-[#1a1a4e]
        ${isHistory ? 'bg-emerald-50/60' : 'bg-blue-50'}
        hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 shadow-sm`}
    >
      {/* Top row: job number + status */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-full bg-[#1a1a4e] flex items-center justify-center flex-shrink-0">
            <FileText className="w-4 h-4 text-white" />
          </div>
          <span className="text-[#1a1a4e] font-bold text-base truncate">
            {job.job_number || job.id.slice(0, 8)}
          </span>
        </div>
        <span className={`text-white text-xs font-semibold px-3 py-1 rounded-full flex-shrink-0
          ${isHistory ? 'bg-emerald-600' : 'bg-[#1a1a4e]'}`}>
          {formatStatus(job.status)}
        </span>
      </div>

      {/* Middle: weight + items */}
      <div className="mx-4 mb-3 bg-white/70 rounded-lg px-3 py-2.5 space-y-1.5">
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <Package className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <span>Total Weight: <span className="font-bold text-slate-900">{weight.toFixed(2)} kg</span></span>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <Box className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <span>Items: <span className="font-bold text-slate-900">{items}</span></span>
        </div>
      </div>

      {/* Bottom: received date */}
      <div className="px-4 pb-2 pt-2 border-t border-slate-200/60 flex items-center gap-2">
        <Calendar className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
        <span className="text-xs text-slate-500">
          Received: {formatDate(job.received_at || job.created_at)}
        </span>
      </div>

      {/* Footer: tap for details */}
      <div className="px-4 pb-3 flex items-center justify-center gap-1 text-xs text-slate-500 group-hover:text-[#1a1a4e] transition-colors">
        <span>Tap for details</span>
        <ChevronRight className="w-3.5 h-3.5" />
      </div>
    </button>
  );
};

export default JobCard;
