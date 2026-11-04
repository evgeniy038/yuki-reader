import { useRef, useState, type ReactNode } from "react";
import {
  CaretRight,
  CheckCircle,
  DownloadSimple,
  UploadSimple,
} from "@/components/ui/icons";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  BackupCancelledError,
  type BackupOperationProgress,
  type BackupTask,
  DEFAULT_BACKUP_OPTIONS,
  exportBackupTask,
  importBackupTask,
  type BackupOptions,
} from "@/core/backup";
import { SettingsGroup } from "./settings-group";
import { BackupExportDialog } from "./backup-export-dialog";
import { BackupImportDialog } from "./backup-import-dialog";

type OpenDialog = "export" | "import" | null;

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
  const taskRef = useRef<BackupTask<unknown> | null>(null);
  const [options, setOptions] = useState<BackupOptions>(DEFAULT_BACKUP_OPTIONS);
  const [open, setOpen] = useState<OpenDialog>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [progress, setProgress] = useState<BackupOperationProgress | null>(null);
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
        icon: <CheckCircle filled className="size-4 text-primary" />,
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
          icon: <CheckCircle filled className="size-4 text-primary" />,
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

      <BackupExportDialog
        open={open === "export"}
        busy={busy === "export"}
        options={options}
        onOptionChange={setOption}
        progress={progress}
        label={transferLabel}
        detail={transferDetail}
        error={error}
        onExport={() => void download()}
        onCancelTask={cancelTask}
        onClose={closeDialog}
      />
      <BackupImportDialog
        open={open === "import"}
        busy={busy === "import"}
        progress={progress}
        label={transferLabel}
        detail={transferDetail}
        error={error}
        onFile={(file) => {
          if (file) void restore(file);
        }}
        onCancelTask={cancelTask}
        onClose={closeDialog}
      />
    </>
  );
}
