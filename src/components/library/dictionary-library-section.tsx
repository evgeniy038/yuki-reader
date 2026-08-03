import { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  CaretUp,
  CheckCircle,
  DownloadSimple,
  FileArrowUp,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DICTIONARY_CATALOG,
  DICTIONARIES_ENABLED,
  importDictionaryArchive,
  installDictionaryFromUrl,
  loadAllDictionaries,
  removeDictionary,
  reorderDictionaries,
  updateDictionaryEnabled,
  type DictionaryProgress,
  type DictionaryProgressPhase,
  type DictionaryRecord,
} from "@/core/dictionaries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ProgressRing } from "@/components/ui/progress-ring";
import { SettingsBlock, SettingsGroup, SettingsRow } from "./settings-group";

const DICTIONARY_PROGRESS_RANGES: Record<
  DictionaryProgressPhase,
  readonly [number, number]
> = {
  download: [0, 0.55],
  unpack: [0.55, 0.65],
  index: [0.65, 0.82],
  save: [0.82, 1],
};

function dictionaryPercent(progress: DictionaryProgress | null): number {
  if (!progress) return 0;
  const [start, end] = DICTIONARY_PROGRESS_RANGES[progress.phase];
  if (progress.total <= 0) return Math.round(start * 100);
  const fraction = Math.min(1, Math.max(0, progress.current / progress.total));
  const percent = Math.round((start + (end - start) * fraction) * 100);
  return progress.phase === "save" && progress.current < progress.total
    ? Math.min(99, percent)
    : percent;
}

function DictionaryProgressIndicator({
  progress,
  label,
}: {
  progress: DictionaryProgress | null;
  label: string;
}) {
  const percent = dictionaryPercent(progress);
  const description = `${label}, ${percent}%`;
  return (
    <div
      role="status"
      aria-label={description}
      title={description}
      className="size-9 shrink-0"
    >
      <ProgressRing value={percent / 100} className="size-9">
        <span className="text-[9px] font-medium tabular-nums text-strong">
          {percent}%
        </span>
      </ProgressRing>
    </div>
  );
}

export function DictionaryLibrarySection() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dictionaries, setDictionaries] = useState<DictionaryRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<DictionaryProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const refresh = () => {
    void loadAllDictionaries().then(setDictionaries);
  };

  useEffect(() => {
    refresh();
  }, []);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setProgress(null);
    setError(null);
    try {
      await action();
      refresh();
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("settings.dictionaries.error"),
      );
      return false;
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const onImport = async (file: File) => {
    if (!DICTIONARIES_ENABLED) return;
    const imported = await run(file.name, async () => {
      await importDictionaryArchive(
        new Uint8Array(await file.arrayBuffer()),
        {},
        (next) => setProgress(next),
      );
    });
    if (imported) setAddOpen(false);
  };

  const installRecommended = async (item: (typeof DICTIONARY_CATALOG)[number]) => {
    if (!DICTIONARIES_ENABLED) return;
    const installed = await run(item.id, () =>
      installDictionaryFromUrl(item, (next) => setProgress(next)),
    );
    if (installed) {
      toast.success(t("settings.dictionaries.ready", { title: item.title }), {
        icon: <CheckCircle className="size-4 text-primary" weight="fill" />,
      });
    }
  };

  const toggle = (dictionary: DictionaryRecord, enabled: boolean) => {
    if (!DICTIONARIES_ENABLED) return;
    void run(dictionary.id, () => updateDictionaryEnabled(dictionary.id, enabled));
  };

  const remove = (dictionary: DictionaryRecord) => {
    void run(dictionary.id, () => removeDictionary(dictionary.id));
  };

  const move = (index: number, direction: -1 | 1) => {
    const next = dictionaries.slice();
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setDictionaries(next);
    void run("reorder", () =>
      reorderDictionaries(next.map((dictionary) => dictionary.id)),
    );
  };

  return (
    <>
      <SettingsGroup
        title={t("settings.dictionaries.title")}
        actions={
          <Button
            size="sm"
            onClick={() => {
              setError(null);
              setAddOpen(true);
            }}
            disabled={busy !== null || !DICTIONARIES_ENABLED}
          >
            <Plus />
            {t("settings.dictionaries.add")}
          </Button>
        }
      >
        <SettingsRow label={t("settings.dictionaries.enabled")}>
          <Switch
            checked={DICTIONARIES_ENABLED}
            onCheckedChange={() => undefined}
            ariaLabel={t("settings.dictionaries.enabledAria")}
            disabled
          />
        </SettingsRow>
        <SettingsBlock>
          {dictionaries.length > 0 ? (
            <div className="-mx-4 -my-3 divide-y divide-subtle">
              {dictionaries.map((dictionary, index) => (
                <div
                  key={dictionary.id}
                  className="flex min-h-11 items-center gap-3 px-4 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-default">
                      {dictionary.title}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-content">
                      {t("settings.dictionaries.entries", {
                        count: dictionary.entryCount,
                      })}
                      {dictionary.revision ? ` · ${dictionary.revision}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("settings.dictionaries.moveUp")}
                      title={t("settings.dictionaries.moveUp")}
                      disabled={index === 0 || busy !== null}
                      onClick={() => move(index, -1)}
                    >
                      <CaretUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("settings.dictionaries.moveDown")}
                      title={t("settings.dictionaries.moveDown")}
                      disabled={index === dictionaries.length - 1 || busy !== null}
                      onClick={() => move(index, 1)}
                    >
                      <CaretDown />
                    </Button>
                    <Switch
                      checked={dictionary.enabled}
                      onCheckedChange={(checked) => toggle(dictionary, checked)}
                      ariaLabel={t("settings.dictionaries.toggle", {
                        title: dictionary.title,
                      })}
                      disabled={busy !== null || !DICTIONARIES_ENABLED}
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("settings.dictionaries.remove")}
                      title={t("settings.dictionaries.remove")}
                      disabled={busy !== null}
                      onClick={() => remove(dictionary)}
                    >
                      <Trash className="text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-content">
              {t("settings.dictionaries.empty")}
            </p>
          )}
          {error && !addOpen ? (
            <p className="mt-3 text-xs text-destructive">{error}</p>
          ) : null}
        </SettingsBlock>
      </SettingsGroup>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{t("settings.dictionaries.addTitle")}</DialogTitle>
          </DialogHeader>

          <div className="divide-y divide-subtle">
            {DICTIONARY_CATALOG.map((item) => {
              const installed = dictionaries.some(
                (dictionary) => dictionary.id === item.id,
              );
              const installing = busy === item.id;
              const stage = progress?.phase ?? "download";
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-default">
                      {item.title}
                    </p>
                    <p className="truncate text-xs text-muted-content">
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {item.sourceLabel}
                      </a>{" "}
                      · {item.license}
                    </p>
                  </div>
                  {installed ? (
                    <span className="shrink-0 text-xs text-muted-content">
                      {t("settings.dictionaries.installed")}
                    </span>
                  ) : installing ? (
                    <DictionaryProgressIndicator
                      progress={progress}
                      label={t(`settings.dictionaries.stage.${stage}`)}
                    />
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy !== null || !DICTIONARIES_ENABLED}
                      onClick={() => void installRecommended(item)}
                    >
                      {busy === item.id ? null : <DownloadSimple />}
                      {t("settings.dictionaries.install")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-subtle pt-3">
            <p className="text-xs text-muted-content">
              {t("settings.dictionaries.importHint")}
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void onImport(file);
              }}
            />
            {busy !== null &&
            !DICTIONARY_CATALOG.some((item) => item.id === busy) ? (
              <DictionaryProgressIndicator
                progress={progress}
                label={t(
                  `settings.dictionaries.stage.${progress?.phase ?? "unpack"}`,
                )}
              />
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="!shadow-none"
                onClick={() => inputRef.current?.click()}
                disabled={busy !== null || !DICTIONARIES_ENABLED}
              >
                <FileArrowUp />
                {t("settings.dictionaries.importZip")}
              </Button>
            )}
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
