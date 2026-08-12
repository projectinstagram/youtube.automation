import { clsx } from 'clsx';
import type { VideoStatus, JobStatus } from '@/types';

type Status = VideoStatus | JobStatus | string;

const STATUS_STYLES: Record<string, string> = {
  DISCOVERED: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  QUEUED: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  PROCESSING: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  READY: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  UPLOADING: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  UPLOADED: 'bg-green-500/15 text-green-400 border-green-500/30',
  FAILED: 'bg-red-500/15 text-red-400 border-red-500/30',
  SKIPPED: 'bg-gray-500/15 text-gray-500 border-gray-600/30',
  PENDING: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  RUNNING: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  COMPLETED: 'bg-green-500/15 text-green-400 border-green-500/30',
  CANCELLED: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

const STATUS_DOTS: Record<string, string> = {
  DISCOVERED: 'bg-gray-400',
  QUEUED: 'bg-blue-400',
  PROCESSING: 'bg-yellow-400 animate-pulse',
  READY: 'bg-cyan-400',
  UPLOADING: 'bg-purple-400 animate-pulse',
  UPLOADED: 'bg-green-400',
  FAILED: 'bg-red-400',
  SKIPPED: 'bg-gray-500',
  PENDING: 'bg-blue-400',
  RUNNING: 'bg-yellow-400 animate-pulse',
  COMPLETED: 'bg-green-400',
  CANCELLED: 'bg-gray-400',
};

interface StatusBadgeProps {
  status: Status;
  showDot?: boolean;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, showDot = true, size = 'sm' }: StatusBadgeProps) {
  const style = STATUS_STYLES[status] || 'bg-gray-500/15 text-gray-400 border-gray-500/30';
  const dot = STATUS_DOTS[status] || 'bg-gray-400';

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border font-medium',
        style,
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'
      )}
    >
      {showDot && <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', dot)} />}
      {status}
    </span>
  );
}
