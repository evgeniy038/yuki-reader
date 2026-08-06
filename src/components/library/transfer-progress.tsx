import type {
  BackupOperationProgress,
  BackupOperationProgressPhase,
} from "@/core/backup";

export const BACKUP_PROGRESS_RANGES: Record<
  BackupOperationProgressPhase,
  readonly [number, number]
> = {
  // Prepare is the real work (page-granular); packing the streaming archive
  // is a short final beat.
  prepare: [0, 0.9],
  pack: [0.9, 1],
  unpack: [0, 0.15],
  restore: [0.15, 1],
};

// A phased transfer's overall percent: each phase owns a slice of the 0..100
// bar; inside a phase the fraction is current/total, clamped.
export function phasePercent<Phase extends string>(
  progress: { phase: Phase; current: number; total: number } | null,
  ranges: Record<Phase, readonly [number, number]>,
): number {
  if (!progress) return 0;
  const [start, end] = ranges[progress.phase];
  if (progress.total <= 0) return Math.round(start * 100);
  const fraction = Math.min(1, Math.max(0, progress.current / progress.total));
  return Math.round((start + (end - start) * fraction) * 100);
}

// Vertical, centered: the current step on top, a live detail line under it,
// a large percent figure, and the bar pinned to the bottom edge — the block
// fills its fixed height instead of floating in emptiness.
export function TransferProgress({
  progress,
  label,
  detail,
}: {
  progress: BackupOperationProgress | null;
  label: string;
  detail?: string;
}) {
  const percent = phasePercent(progress, BACKUP_PROGRESS_RANGES);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center gap-1 text-center"
    >
      <span className="text-sm font-medium text-default">{label}</span>
      <span className="min-h-4 truncate text-xs tabular-nums text-muted-content">
        {detail ?? " "}
      </span>
      <span className="mt-1 text-2xl font-semibold tabular-nums text-default">
        {percent}%
      </span>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted-surface"
      >
        <div
          className="h-full rounded-full bg-primary-gradient transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
