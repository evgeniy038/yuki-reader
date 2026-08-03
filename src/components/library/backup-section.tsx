import { useRef, useState } from "react";
import {
  DownloadSimple,
  FileArrowUp,
  UploadSimple,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_BACKUP_OPTIONS,
  exportBackup,
  importBackup,
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
import { SettingsBlock, SettingsGroup } from "./settings-group";

type OpenDialog = "export" | "import" | null;

export function BackupSection() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState<BackupOptions>(DEFAULT_BACKUP_OPTIONS);
  const [open, setOpen] = useState<OpenDialog>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setOption = (key: keyof BackupOptions, value: boolean) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };

  const openDialog = (next: Exclude<OpenDialog, null>) => {
    setMessage(null);
    setError(null);
    setOpen(next);
  };

  const download = async () => {
    setBusy("export");
    setError(null);
    try {
      const blob = await exportBackup(options);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `yuki-progress-${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(t("settings.backup.exported"));
      setOpen(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("settings.backup.error"),
      );
    } finally {
      setBusy(null);
    }
  };

  const restore = async (file: File) => {
    setBusy("import");
    setError(null);
    try {
      const summary = await importBackup(file);
      setMessage(
        t("settings.backup.imported", {
          progress: summary.progress,
        }),
      );
      setOpen(null);
      window.setTimeout(() => window.location.reload(), 350);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("settings.backup.error"),
      );
      setBusy(null);
    }
  };

  const chooseFile = (file: File | undefined) => {
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
        <SettingsBlock>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              variant="secondary"
              className="justify-start"
              onClick={() => openDialog("export")}
              disabled={busy !== null}
            >
              <UploadSimple />
              {t("settings.backup.export")}
            </Button>
            <Button
              variant="secondary"
              className="justify-start"
              onClick={() => openDialog("import")}
              disabled={busy !== null}
            >
              <DownloadSimple />
              {t("settings.backup.import")}
            </Button>
          </div>
          {message ? (
            <p className="mt-2 text-xs text-muted-content">{message}</p>
          ) : null}
        </SettingsBlock>
      </SettingsGroup>

      <Dialog
        open={open === "export"}
        onOpenChange={(next) => !next && setOpen(null)}
      >
        <DialogContent className="max-w-sm gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{t("settings.backup.exportTitle")}</DialogTitle>
          </DialogHeader>
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
                  disabled={busy !== null}
                />
              </div>
            ))}
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setOpen(null)}
              disabled={busy !== null}
            >
              {t("settings.backup.cancel")}
            </Button>
            <Button loading={busy === "export"} onClick={() => void download()}>
              {busy === "export" ? null : <UploadSimple />}
              {t("settings.backup.export")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={open === "import"}
        onOpenChange={(next) => !next && setOpen(null)}
      >
        <DialogContent className="max-w-md gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{t("settings.backup.importTitle")}</DialogTitle>
            <p className="text-sm text-muted-content">
              {t("settings.backup.importHint")}
            </p>
          </DialogHeader>
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
              setDragging(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
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
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setOpen(null)}
              disabled={busy !== null}
            >
              {t("settings.backup.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
