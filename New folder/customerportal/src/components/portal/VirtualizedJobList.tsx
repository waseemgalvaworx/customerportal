import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import JobCard, { type Job } from './JobCard';

/**
 * VirtualizedJobList — windowed renderer for long job lists.
 *
 * Used in the customer portal's Active jobs view and inside any history
 * month group that contains more than `threshold` jobs (default 50).
 *
 * Below the threshold we fall back to a plain map() so small lists pay
 * no virtualization overhead. Above it we use @tanstack/react-virtual to
 * keep DOM nodes proportional to viewport size, dramatically improving
 * scroll performance and memory usage on customers with thousands of
 * historical jobs.
 *
 * Estimated row height matches the JobCard's approximate rendered height
 * (~140px including the 12px gap between cards). The virtualizer measures
 * actual heights after first render and adjusts automatically.
 */
interface VirtualizedJobListProps {
  jobs: Job[];
  variant: 'active' | 'history';
  onSelect: (job: Job) => void;
  /** Render plainly until list exceeds this many items. Default 50. */
  threshold?: number;
  /** Estimated row height in px (incl. gap). Default 152. */
  estimateSize?: number;
  /** Maximum height of the scroll container. Default '70vh'. */
  maxHeight?: string;
}

const VirtualizedJobList: React.FC<VirtualizedJobListProps> = ({
  jobs,
  variant,
  onSelect,
  threshold = 50,
  estimateSize = 152,
  maxHeight = '70vh',
}) => {
  // Small lists: render directly for simplicity and zero overhead.
  if (jobs.length <= threshold) {
    return (
      <div className="space-y-3">
        {jobs.map((j) => (
          <JobCard key={j.id} job={j} onClick={onSelect} variant={variant} />
        ))}
      </div>
    );
  }

  return <VirtualList jobs={jobs} variant={variant} onSelect={onSelect} estimateSize={estimateSize} maxHeight={maxHeight} />;
};

const VirtualList: React.FC<Required<Pick<VirtualizedJobListProps, 'jobs' | 'variant' | 'onSelect' | 'estimateSize' | 'maxHeight'>>> = ({
  jobs,
  variant,
  onSelect,
  estimateSize,
  maxHeight,
}) => {
  const parentRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: jobs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan: 6,
  });

  return (
    <div
      ref={parentRef}
      style={{ maxHeight }}
      className="overflow-auto rounded-lg"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((vRow) => {
          const job = jobs[vRow.index];
          return (
            <div
              key={job.id}
              data-index={vRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vRow.start}px)`,
                paddingBottom: 12,
              }}
            >
              <JobCard job={job} onClick={onSelect} variant={variant} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default VirtualizedJobList;
