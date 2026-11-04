import { useTranslation } from "react-i18next";
import type { DirectStage } from "@/components/sync/p2p";
import type { SyncView } from "@/components/sync/sync-controller";
import { CloudArrowDown, CloudArrowUp, DownloadSimple } from "@/components/ui/icons";
import { ProgressBar } from "@/components/ui/progress-bar";
import { phasePercent } from "./transfer-progress";

// What sync is doing right now, in Settings → Sync — no sentences, just
// where things stand: a thin bar along the status row while a round runs
// (the other devices' changes read, this one's published, book files
// checked), and a row per book on its way, up to the cloud, down from it
// or straight from another device, with its share done. Nothing moves:
// nothing shows.

const ROUND_RANGES = { pull: [0, 0.5], push: [0.5, 0.85], files: [0.85, 1] } as const;

/** The round's bar, laid over the bottom edge of the status row. Only
    while a round runs: mounted fresh each time, it never runs backwards. */
export function RoundBar({ round }: { round: SyncView["round"] }) {
  const { t } = useTranslation();
  if (!round) return null;
  return (
    <ProgressBar
      value={phasePercent({ phase: round.phase, current: round.done, total: round.total }, ROUND_RANGES) / 100}
      label={t("settings.sync.syncing")}
      className="pointer-events-none absolute inset-x-4 -bottom-px h-0.5"
    />
  );
}

interface Transfer {
  key: string;
  title: string;
  way: "up" | "down" | "direct";
  progress: number;
  /** A direct transfer before its first byte: where it stands. */
  stage?: string;
}

export function transfersOf(
  view: SyncView,
  stageLabel: (stage: DirectStage, device: string) => string,
  device: (item: SyncView["cloud"][number]) => string,
): Transfer[] {
  const out: Transfer[] = Object.entries(view.uploads).map(([key, upload]) => ({
    key,
    title: upload.title,
    way: "up",
    progress: upload.progress,
  }));
  for (const [key, progress] of Object.entries(view.downloads)) {
    const item = view.cloud.find((entry) => entry.key === key);
    if (!item) continue;
    const stage = view.direct[key];
    out.push({
      key,
      title: item.desc.title,
      way: item.from ? "direct" : "down",
      progress,
      ...(stage ? { stage: stageLabel(stage, device(item)) } : {}),
    });
  }
  return out;
}

const WAY_ICON = { up: CloudArrowUp, down: CloudArrowDown, direct: DownloadSimple } as const;

export function SyncTransfers({ transfers }: { transfers: Transfer[] }) {
  return (
    <ul className="flex flex-col gap-4" data-sync-transfers="">
      {transfers.map((transfer) => {
        const Icon = WAY_ICON[transfer.way];
        const percent = Math.round(transfer.progress * 100);
        return (
          <li key={`${transfer.way}:${transfer.key}`} data-sync-transfer={transfer.way} className="flex items-center gap-3">
            <Icon className="size-4 shrink-0 text-muted-content" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-default" title={transfer.title}>
                  {transfer.title}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-content">{transfer.stage ?? `${percent}%`}</span>
              </div>
              <ProgressBar value={transfer.stage ? 0 : transfer.progress} label={transfer.title} className="mt-1.5" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
