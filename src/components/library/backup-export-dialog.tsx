import { useTranslation } from "react-i18next";
import { UploadSimple } from "@phosphor-icons/react";
import type {
  BackupOperationProgress,
  BackupOptions,
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
import { TransferProgress } from "./transfer-progress";

// The export dialog: the options checklist, replaced in place by the live
// transfer readout once the archive starts building.
export function BackupExportDialog({
  open,
  busy,
  options,
  onOptionChange,
  progress,
  label,
  detail,
  error,
  onExport,
  onCancelTask,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  options: BackupOptions;
  onOptionChange: (key: keyof BackupOptions, value: boolean) => void;
  progress: BackupOperationProgress | null;
  label: string;
  detail?: string;
  error: string | null;
  onExport: () => void;
  onCancelTask: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

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
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm gap-4 p-5">
        <DialogHeader>
          <DialogTitle>{t("settings.backup.exportTitle")}</DialogTitle>
        </DialogHeader>
        {busy ? (
          // Same height as the options list it replaces — the dialog
          // doesn't jump when the transfer starts.
          <div className="flex min-h-50 flex-col justify-center">
            <TransferProgress
              progress={progress}
              label={label}
              detail={detail}
            />
          </div>
        ) : (
          <>
            <div className="divide-y divide-subtle overflow-hidden rounded-lg border border-subtle">
              {exportRows.map(([key, rowLabel, ariaLabel]) => (
                <div
                  key={key}
                  className="flex min-h-10 items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="text-sm text-default">{rowLabel}</span>
                  <Switch
                    checked={options[key]}
                    onCheckedChange={(value) => onOptionChange(key, value)}
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
            onClick={busy ? onCancelTask : onClose}
          >
            {t("settings.backup.cancel")}
          </Button>
          {busy ? (
            <Button loading>
              <UploadSimple />
              {t("settings.backup.export")}
            </Button>
          ) : (
            <Button onClick={onExport}>
              <UploadSimple />
              {t("settings.backup.export")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
