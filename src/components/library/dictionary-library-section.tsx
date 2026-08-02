import { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  CaretUp,
  DownloadSimple,
  FileArrowUp,
  Trash,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
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
import { Switch } from "@/components/ui/switch";
import { SettingsBlock, SettingsGroup } from "./settings-group";

export function DictionaryLibrarySection() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dictionaries, setDictionaries] = useState<DictionaryRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void loadAllDictionaries().then(setDictionaries);
  };

  useEffect(() => {
    refresh();
  }, []);

  const install = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await action();
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.dictionaries.error"));
    } finally {
      setBusy(null);
    }
  };

  const onImport = async (file: File) => {
    await install(file.name, async () => {
      await importDictionaryArchive(new Uint8Array(await file.arrayBuffer()));
    });
  };

  const toggle = (dictionary: DictionaryRecord, enabled: boolean) => {
    void install(dictionary.id, () => updateDictionaryEnabled(dictionary.id, enabled));
  };

  const remove = (dictionary: DictionaryRecord) => {
    void install(dictionary.id, () => removeDictionary(dictionary.id));
  };

  const move = (index: number, direction: -1 | 1) => {
    const next = dictionaries.slice();
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setDictionaries(next);
    void install("reorder", () => reorderDictionaries(next.map((dictionary) => dictionary.id)));
  };

  return (
    <SettingsGroup
      title={t("settings.dictionaries.title")}
      actions={
        <>
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
            variant="ghost"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={busy !== null}
          >
            <FileArrowUp />
            {t("settings.dictionaries.import")}
          </Button>
        </>
      }
    >
      <SettingsBlock>
        <p className="text-sm text-muted-content">
          {t("settings.dictionaries.hint")}
        </p>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
        {dictionaries.length > 0 ? (
          <div className="mt-4 flex flex-col divide-y divide-subtle rounded-lg border border-subtle">
            {dictionaries.map((dictionary, index) => (
              <div key={dictionary.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-default">
                    {dictionary.title}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-content">
                    {dictionary.entryCount.toLocaleString()} · {dictionary.revision ?? t("settings.dictionaries.local")}
                  </p>
                </div>
                <div className="flex items-center gap-0.5">
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
                    ariaLabel={t("settings.dictionaries.toggle", { title: dictionary.title })}
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
        ) : null}
        <div className="mt-5 border-t border-subtle pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-content">
            {t("settings.dictionaries.recommended")}
          </p>
          <div className="flex flex-col gap-1">
            {DICTIONARY_CATALOG.map((item) => {
              const installed = dictionaries.some((dictionary) => dictionary.id === item.id);
              return (
                <div key={item.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-default">{item.title}</p>
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
                    <span className="text-xs text-muted-content">{t("settings.dictionaries.installed")}</span>
                  ) : (
                    <Button
                      variant="secondary"
                      size="xs"
                      loading={busy === item.id}
                      disabled={busy !== null}
                      onClick={() => void install(item.id, () => installDictionaryFromUrl(item))}
                    >
                      <DownloadSimple />
                      {t("settings.dictionaries.add")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-content">
          {t("settings.dictionaries.licenseHint")}
        </p>
      </SettingsBlock>
    </SettingsGroup>
  );
}
