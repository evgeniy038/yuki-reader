import { useRef, useState } from "react";
import { DownloadSimple, FileArrowUp } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_BACKUP_OPTIONS,
  exportBackup,
  importBackup,
  type BackupOptions,
} from "@/core/backup";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsBlock, SettingsGroup, SettingsRow } from "./settings-group";

export function BackupSection() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [options, setOptions] = useState<BackupOptions>(DEFAULT_BACKUP_OPTIONS);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const setOption = (key: keyof BackupOptions, value: boolean) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };

  const download = async () => {
    setBusy("export");
    setMessage(null);
    try {
      const blob = await exportBackup(options);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `yuki-backup-${new Date().toISOString().slice(0, 10)}.yuki.zip`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(t("settings.backup.exported"));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t("settings.backup.error"));
    } finally {
      setBusy(null);
    }
  };

  const restore = async (file: File) => {
    setBusy("import");
    setMessage(null);
    try {
      const summary = await importBackup(file);
      setMessage(
        t("settings.backup.imported", {
          books: summary.books,
          dictionaries: summary.dictionaries,
        }),
      );
      window.setTimeout(() => window.location.reload(), 350);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t("settings.backup.error"));
      setBusy(null);
    }
  };

  return (
    <SettingsGroup
      title={t("settings.backup.title")}
      actions={
        <>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.yuki,application/zip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void restore(file);
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => inputRef.current?.click()}
          >
            <FileArrowUp />
            {t("settings.backup.import")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={busy === "export"}
            disabled={busy !== null}
            onClick={() => void download()}
          >
            <DownloadSimple />
            {t("settings.backup.export")}
          </Button>
        </>
      }
    >
      <SettingsBlock>
        <p className="text-sm text-muted-content">{t("settings.backup.hint")}</p>
        <div className="mt-3">
          <SettingsRow label={t("settings.backup.books")}>
            <Switch
              checked={options.books}
              onCheckedChange={(value) => setOption("books", value)}
              ariaLabel={t("settings.backup.booksAria")}
              disabled={busy !== null}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.backup.progress")}>
            <Switch
              checked={options.progress}
              onCheckedChange={(value) => setOption("progress", value)}
              ariaLabel={t("settings.backup.progressAria")}
              disabled={busy !== null}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.backup.stats")}>
            <Switch
              checked={options.stats}
              onCheckedChange={(value) => setOption("stats", value)}
              ariaLabel={t("settings.backup.statsAria")}
              disabled={busy !== null}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.backup.settings")}>
            <Switch
              checked={options.settings}
              onCheckedChange={(value) => setOption("settings", value)}
              ariaLabel={t("settings.backup.settingsAria")}
              disabled={busy !== null}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.backup.dictionaries")}>
            <Switch
              checked={options.dictionaries}
              onCheckedChange={(value) => setOption("dictionaries", value)}
              ariaLabel={t("settings.backup.dictionariesAria")}
              disabled={busy !== null}
            />
          </SettingsRow>
        </div>
        <p className="mt-3 text-xs text-muted-content">
          {t("settings.backup.modelsHint")}
        </p>
        {message ? <p className="mt-2 text-sm text-default">{message}</p> : null}
      </SettingsBlock>
    </SettingsGroup>
  );
}
