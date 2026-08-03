import { useRef, useState, type ReactNode } from "react";
import {
  CaretRight,
  CheckCircle,
  DownloadSimple,
  FileArrowUp,
  UploadSimple,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  BackupCancelledError,
  type BackupOperationProgress,
  type BackupOperationProgressPhase,
  type BackupTask,
  DEFAULT_BACKUP_OPTIONS,
  exportBackupTask,
  importBackupTask,
  type BackupOptions,
} from "@/core/backup";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup } from "./settings-group";

type OpenDialog = "export" | "import" | null;

const BACKUP_PROGRESS_RANGES: Record<
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

function backupPercent(progress: BackupOperationProgress | null): number {
  if (!progress) return 0;
  const [start, end] = BACKUP_PROGRESS_RANGES[progress.phase];
  if (progress.total <= 0) return Math.round(start * 100);
  const fraction = Math.min(1, Math.max(0, progress.current / progress.total));
  return Math.round((start + (end - start) * fraction) * 100);
}

// Vertical, centered: the current step on top, a live detail line under it,
// a large percent figure, and the bar pinned to the bottom edge — the block
// fills its fixed height instead of floating in emptiness.
function TransferProgress({
  progress,
  label,
  detail,
}: {
  progress: BackupOperationProgress | null;
  label: string;
  detail?: string;
}) {
  const percent = backupPercent(progress);
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

// Section action: an iOS-style row — small tinted icon tile, title + one-line
// hint, chevron. The tile is one radius step below the card (ladder rule).
function ActionRow({
  icon,
  title,
  subtitle,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors first:rounded-t-card last:rounded-b-card hover:bg-hover-surface active:bg-active-surface focus-visible:bg-hover-surface focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-default">
          {title}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-content">
          {subtitle}
        </span>
      </span>
      <CaretRight className="size-4 shrink-0 text-muted-content transition-transform duration-150 group-hover:translate-x-0.5" />
    </button>
  );
}

export function BackupSection() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const taskRef = useRef<BackupTask<unknown> | null>(null);
  const [options, setOptions] = useState<BackupOptions>(DEFAULT_BACKUP_OPTIONS);
  const [open, setOpen] = useState<OpenDialog>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [progress, setProgress] = useState<BackupOperationProgress | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setOption = (key: keyof BackupOptions, value: boolean) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };

  const openDialog = (next: Exclude<OpenDialog, null>) => {
    setError(null);
    setProgress(null);
    setOpen(next);
  };

  // While a transfer runs, the only way out of the dialog is Cancel —
  // closing mid-write is not offered.
  const closeDialog = () => {
    if (busy === null) setOpen(null);
  };

  const cancelTask = () => taskRef.current?.cancel();

  const download = async () => {
    setBusy("export");
    setError(null);
    setProgress(null);
    const task = exportBackupTask(options, (next) => setProgress(next));
    taskRef.current = task;
    try {
      const blob = await task.promise;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `yuki-progress-${new Date().toISOString().slice(0, 10)}.zip`;
      // The anchor must be in the DOM and the object URL must outlive the
      // download start — revoking synchronously can abort it (Firefox).
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(t("settings.backup.exported"), {
        icon: <CheckCircle className="size-4 text-primary" weight="fill" />,
      });
      setOpen(null);
    } catch (cause) {
      if (cause instanceof BackupCancelledError) {
        // Export writes nothing — a cancel is a clean, silent reset.
      } else {
        console.error("[backup] export failed", cause);
        setError(t("settings.backup.error"));
      }
    } finally {
      taskRef.current = null;
      setBusy(null);
      setProgress(null);
    }
  };

  const restore = async (file: File) => {
    setBusy("import");
    setError(null);
    setProgress(null);
    const task = importBackupTask(file, (next) => setProgress(next));
    taskRef.current = task;
    try {
      const summary = await task.promise;
      toast.success(
        t("settings.backup.imported", { progress: summary.progress }),
        {
          icon: <CheckCircle className="size-4 text-primary" weight="fill" />,
        },
      );
      setOpen(null);
      // Reload so every screen picks up the restored library; leave a beat
      // for the confirmation toast to be seen first.
      window.setTimeout(() => window.location.reload(), 1000);
    } catch (cause) {
      taskRef.current = null;
      setBusy(null);
      setProgress(null);
      if (cause instanceof BackupCancelledError) {
        // Cancel lands between books: what was restored stays, the rest never
        // happened — say so honestly and reload onto the consistent state.
        const restoredBooks = cause.summary?.books ?? 0;
        if (restoredBooks > 0) {
          toast.info(t("settings.backup.cancelled", { count: restoredBooks }));
          window.setTimeout(() => window.location.reload(), 1000);
        }
        return;
      }
      console.error("[backup] import failed", cause);
      setError(t("settings.backup.error"));
    }
  };

  const transferLabel =
    progress?.phase === "prepare"
      ? t("settings.backup.transfer.prepare")
      : progress?.phase === "pack"
        ? t("settings.backup.transfer.pack")
        : progress?.phase === "unpack"
          ? t("settings.backup.transfer.unpack")
          : progress?.phase === "restore"
            ? t("settings.backup.transfer.restore")
            : busy === "export"
              ? t("settings.backup.transfer.prepare")
              : t("settings.backup.transfer.unpack");

  const transferDetail =
    progress?.item != null
      ? progress.item.kind === "page"
        ? t("settings.backup.itemPage", {
            index: progress.item.index,
            count: progress.item.count,
          })
        : t("settings.backup.itemBook", {
            index: progress.item.index,
            count: progress.item.count,
          })
      : undefined;

  const chooseFile = (file: File | undefined) => {
    dragDepth.current = 0;
    setDragging(false);
    if (file) void restore(file);
  };

  const exportRows: [keyof BackupOptions, string, string][] = [
    ["books", t("settings.backup.books"), t("settings.backup.booksAria")],
    [
      "progress",
      t("settings.backup.progress"),
      t("settings.backup.progressAria"),
    ],
    ["stats", t("settings.backup.stats"), t("settings.backup.statsAria")],
    [
      "settings",
      t("settings.backup.settings"),
      t("settings.backup.settingsAria"),
    ],
    [
      "dictionaries",
      t("settings.backup.dictionaries"),
      t("settings.backup.dictionariesAria"),
    ],
  ];

  return (
    <>
      <SettingsGroup title={t("settings.backup.title")}>
        <ActionRow
          icon={<UploadSimple />}
          title={t("settings.backup.export")}
          subtitle={t("settings.backup.exportSubtitle")}
          onClick={() => openDialog("export")}
          disabled={busy !== null}
        />
        <ActionRow
          icon={<DownloadSimple />}
          title={t("settings.backup.import")}
          subtitle={t("settings.backup.importSubtitle")}
          onClick={() => openDialog("import")}
          disabled={busy !== null}
        />
      </SettingsGroup>

      <Dialog
        open={open === "export"}
        onOpenChange={(next) => !next && closeDialog()}
      >
        <DialogContent className="max-w-sm gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{t("settings.backup.exportTitle")}</DialogTitle>
          </DialogHeader>
          {busy === "export" ? (
            // Same height as the options list it replaces — the dialog
            // doesn't jump when the transfer starts.
            <div className="flex min-h-50 flex-col justify-center">
              <TransferProgress
                progress={progress}
                label={transferLabel}
                detail={transferDetail}
              />
            </div>
          ) : (
            <>
              <div className="divide-y divide-subtle overflow-hidden rounded-lg border border-subtle">
                {exportRows.map(([key, label, ariaLabel]) => (
                  <div
                    key={key}
                    className="flex min-h-10 items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="text-sm text-default">{label}</span>
                    <Switch
                      checked={options[key]}
                      onCheckedChange={(value) => setOption(key, value)}
                      ariaLabel={ariaLabel}
                    />
                  </div>
                ))}
              </div>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={busy === "export" ? cancelTask : closeDialog}
            >
              {t("settings.backup.cancel")}
            </Button>
            {busy === "export" ? (
              <Button loading>
                <UploadSimple />
                {t("settings.backup.export")}
              </Button>
            ) : (
              <Button onClick={() => void download()}>
                <UploadSimple />
                {t("settings.backup.export")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={open === "import"}
        onOpenChange={(next) => !next && closeDialog()}
      >
        <DialogContent className="max-w-md gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{t("settings.backup.importTitle")}</DialogTitle>
            {busy !== "import" ? (
              <p className="text-sm text-muted-content">
                {t("settings.backup.importHint")}
              </p>
            ) : null}
          </DialogHeader>
          {busy === "import" ? (
            // Same height as the dropzone it replaces.
            <div className="flex min-h-36 flex-col justify-center">
              <TransferProgress
                progress={progress}
                label={transferLabel}
                detail={transferDetail}
              />
            </div>
          ) : (
            <>
              <input
                ref={inputRef}
                type="file"
                accept=".zip,.yuki,application/zip"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  chooseFile(file);
                }}
              />
              <div
                role="button"
                tabIndex={0}
                aria-label={t("settings.backup.dropzone")}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    inputRef.current?.click();
                  }
                }}
                onDragEnter={(event) => {
                  event.preventDefault();
                  dragDepth.current += 1;
                  setDragging(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDragLeave={() => {
                  // dragenter/dragleave fire in pairs when the pointer moves
                  // across children — only the outermost leave ends the drag.
                  dragDepth.current = Math.max(0, dragDepth.current - 1);
                  if (dragDepth.current === 0) setDragging(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  chooseFile(event.dataTransfer.files[0]);
                }}
                className={`flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-5 text-center outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 ${
                  dragging
                    ? "border-primary bg-primary/5"
                    : "border-subtle hover:border-strong hover:bg-hover-surface"
                }`}
              >
                <FileArrowUp className="mb-2 size-6 text-muted-content" />
                <p className="text-sm font-medium text-default">
                  {dragging
                    ? t("settings.backup.dropActive")
                    : t("settings.backup.dropzone")}
                </p>
                <p className="mt-1 text-xs text-muted-content">
                  {t("settings.backup.browse")}
                </p>
              </div>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={busy === "import" ? cancelTask : closeDialog}
            >
              {t("settings.backup.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
