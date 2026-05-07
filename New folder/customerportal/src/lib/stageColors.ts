// Stage color palette ported from the React Native customer portal.
// Pending = amber, Workshop = blue, Acid = red, Galva = purple,
// Finishing = pink, Ready = green.

export type StageKey = 'pending' | 'workshop' | 'acid' | 'galva' | 'finishing' | 'ready' | 'other';

export interface StageStyle {
  key: StageKey;
  label: string;
  bar: string;        // tailwind bg color for segmented progress fill
  badgeBg: string;    // light bg for chips
  badgeText: string;  // text color on light bg
  dot: string;        // solid dot color
  ring: string;       // ring color
}

export const STAGE_STYLES: Record<StageKey, StageStyle> = {
  pending:   { key: 'pending',   label: 'Pending',   bar: 'bg-amber-500',  badgeBg: 'bg-amber-100',  badgeText: 'text-amber-800',  dot: 'bg-amber-500',  ring: 'ring-amber-300' },
  workshop:  { key: 'workshop',  label: 'Workshop',  bar: 'bg-blue-500',   badgeBg: 'bg-blue-100',   badgeText: 'text-blue-800',   dot: 'bg-blue-500',   ring: 'ring-blue-300' },
  acid:      { key: 'acid',      label: 'Acid',      bar: 'bg-rose-500',   badgeBg: 'bg-rose-100',   badgeText: 'text-rose-800',   dot: 'bg-rose-500',   ring: 'ring-rose-300' },
  galva:     { key: 'galva',     label: 'Galva',     bar: 'bg-violet-500', badgeBg: 'bg-violet-100', badgeText: 'text-violet-800', dot: 'bg-violet-500', ring: 'ring-violet-300' },
  finishing: { key: 'finishing', label: 'Finishing', bar: 'bg-pink-500',   badgeBg: 'bg-pink-100',   badgeText: 'text-pink-800',   dot: 'bg-pink-500',   ring: 'ring-pink-300' },
  ready:     { key: 'ready',     label: 'Ready',     bar: 'bg-emerald-500',badgeBg: 'bg-emerald-100',badgeText: 'text-emerald-800',dot: 'bg-emerald-500',ring: 'ring-emerald-300' },
  other:     { key: 'other',     label: 'Other',     bar: 'bg-slate-400',  badgeBg: 'bg-slate-100',  badgeText: 'text-slate-700',  dot: 'bg-slate-400',  ring: 'ring-slate-300' },
};

export const STAGE_ORDER: StageKey[] = ['workshop', 'acid', 'galva', 'finishing', 'ready'];

export function classifyStage(raw?: string | null): StageKey {
  if (!raw) return 'other';
  const s = String(raw).toLowerCase();
  if (s.includes('pending') || s.includes('queued') || s.includes('await')) return 'pending';
  if (s.includes('ready') || s.includes('complete') || s.includes('done') || s.includes('shipped') || s.includes('deliver')) return 'ready';
  if (s.includes('finish') || s.includes('paint') || s.includes('powder')) return 'finishing';
  if (s.includes('galva') || s.includes('zinc') || s.includes('dip')) return 'galva';
  if (s.includes('acid') || s.includes('pickl') || s.includes('clean')) return 'acid';
  if (s.includes('workshop') || s.includes('fabric') || s.includes('weld') || s.includes('prep') || s.includes('progress') || s.includes('active')) return 'workshop';
  return 'other';
}

export function stageStyleFor(raw?: string | null): StageStyle {
  return STAGE_STYLES[classifyStage(raw)];
}
