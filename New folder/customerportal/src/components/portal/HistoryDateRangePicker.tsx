import React, { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Calendar as CalendarComp } from '@/components/ui/calendar';
import { Calendar as CalendarIcon, X } from 'lucide-react';
import type { DateRange } from 'react-day-picker';

interface Props {
  range: DateRange | undefined;
  onChange: (range: DateRange | undefined) => void;
}

const fmt = (d?: Date) => d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

const presets = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 12 months', days: 365 },
];

const HistoryDateRangePicker: React.FC<Props> = ({ range, onChange }) => {
  const [open, setOpen] = useState(false);

  const applyPreset = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - days);
    onChange({ from, to });
    setOpen(false);
  };

  const label = range?.from
    ? range.to
      ? `${fmt(range.from)} – ${fmt(range.to)}`
      : fmt(range.from)
    : 'All time';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="gap-2">
          <CalendarIcon className="w-4 h-4" />
          {label}
          {range?.from && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange(undefined); }}
              className="ml-1 hover:bg-slate-200 rounded p-0.5 cursor-pointer"
              aria-label="Clear date range"
            >
              <X className="w-3 h-3" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <div className="flex">
          <div className="border-r p-2 space-y-1 w-36">
            {presets.map((p) => (
              <Button
                key={p.label}
                variant="ghost"
                size="sm"
                className="w-full justify-start text-sm"
                onClick={() => applyPreset(p.days)}
              >
                {p.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-sm"
              onClick={() => { onChange(undefined); setOpen(false); }}
            >
              All time
            </Button>
          </div>
          <CalendarComp
            mode="range"
            selected={range}
            onSelect={onChange}
            numberOfMonths={2}
            initialFocus
          />
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default HistoryDateRangePicker;
