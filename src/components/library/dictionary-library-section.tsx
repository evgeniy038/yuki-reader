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
  importDictionaryArchive,
  installDictionaryFromUrl,
  loadAllDictionaries,
  removeDictionary,
  reorderDictionaries,
  updateDictionaryEnabled,
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
import { SettingsBlock, SettingsGroup } from "./settings-group";

export function DictionaryLibrarySection() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dictionaries, setDictionaries] = useState<DictionaryRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
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
    }
  };

  const onImport = async (file: File) => {
    const imported = await run(file.name, async () => {
      await importDictionaryArchive(new Uint8Array(await file.arrayBuffer()));
    });
    if (imported) setAddOpen(false);
  };

  const installRecommended = async (item: (typeof DICTIONARY_CATALOG)[number]) => {
    const installed = await run(item.id, () => installDictionaryFromUrl(item));
    if (installed) {
      toast.success(t("settings.dictionaries.ready", { title: item.title }), {
        icon: <CheckCircle className="size-4 text-primary" weight="fill" />,
      });
    }
  };

  const toggle = (dictionary: DictionaryRecord, enabled: boolean) => {
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
            disabled={busy !== null}
          >
            <Plus />
            {t("settings.dictionaries.add")}
          </Button>
        }
      >
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
                      disabled={busy !== null}
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
                  ) : (
                    <Button
                      size="sm"
                      loading={busy === item.id}
                      disabled={busy !== null}
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
            <Button
              variant="secondary"
              size="sm"
              className="!shadow-none"
              onClick={() => inputRef.current?.click()}
              disabled={busy !== null}
            >
              <FileArrowUp />
              {t("settings.dictionaries.importZip")}
            </Button>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
