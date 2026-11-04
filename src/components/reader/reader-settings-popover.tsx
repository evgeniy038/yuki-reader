import { type ReadingSettings } from "@/core/reading-settings";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import {
  FontFamilyControl,
  FontSizeControl,
  FontWeightControl,
  ThemeControl,
} from "./reading-font-controls";

// The reader's quick settings popover: reading theme always (it recolors PDF
// pages too), font controls only for the text reader — PDF pages are images
// of print, font settings don't apply there. The page-turn animation switch
// shows on touch screens only (mouse and keys turn without one). An
// invisible backdrop swallows outside clicks; Escape closes.
export function ReaderSettingsPopover({
  settings,
  onSettingsChange,
  showFontSettings,
  showMangaSettings = false,
  mangaFirstPageAsCover = true,
  onMangaFirstPageAsCoverChange,
  fullscreen = false,
  onClose,
}: {
  settings: ReadingSettings;
  onSettingsChange: (settings: ReadingSettings) => void;
  showFontSettings: boolean;
  showMangaSettings?: boolean;
  mangaFirstPageAsCover?: boolean;
  onMangaFirstPageAsCoverChange?: (checked: boolean) => void;
  /** In fullscreen the chrome pill parks lower (system owns the top strip) —
      the popover follows it down instead of overlapping. */
  fullscreen?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <button
        type="button"
        aria-label={t("reader.closeSettings")}
        onClick={onClose}
        className="pointer-events-auto absolute inset-0 z-30"
      />
      <div
        className={cn(
          "pointer-events-auto absolute left-1/2 z-40 flex w-64 origin-top -translate-x-1/2 animate-in flex-col gap-3 rounded-card border border-subtle bg-raised p-3 shadow-floating fade-in-0 zoom-in-95 duration-100 pointer-coarse:w-72",
          fullscreen ? "top-24" : "top-safe-16 pointer-coarse:top-safe-18",
        )}
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-content">{t("settings.theme")}</span>
          <ThemeControl
            settings={settings}
            onSettingsChange={onSettingsChange}
          />
        </div>
        {showFontSettings ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-content">{t("settings.font")}</span>
              <FontFamilyControl
                settings={settings}
                onSettingsChange={onSettingsChange}
                triggerClassName="w-full"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-content">{t("settings.weight")}</span>
              <FontWeightControl
                settings={settings}
                onSettingsChange={onSettingsChange}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-content">{t("settings.size")}</span>
              <div className="flex justify-center">
                <FontSizeControl
                  settings={settings}
                  onSettingsChange={onSettingsChange}
                  decreaseLabel={t("reader.smaller")}
                  increaseLabel={t("reader.larger")}
                />
              </div>
            </div>
          </>
        ) : null}
        {showMangaSettings ? (
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs text-muted-content">
              {t("settings.firstPageAsCover")}
            </span>
            <Switch
              checked={mangaFirstPageAsCover}
              onCheckedChange={(checked) =>
                onMangaFirstPageAsCoverChange?.(checked)
              }
              ariaLabel={t("settings.firstPageAsCover")}
            />
          </div>
        ) : null}
        <div className="hidden items-center justify-between gap-4 pointer-coarse:flex">
          <span className="text-xs text-muted-content">
            {t("settings.pageTurnAnimation")}
          </span>
          <Switch
            checked={settings.pageTurnAnimation}
            onCheckedChange={(pageTurnAnimation) =>
              onSettingsChange({ ...settings, pageTurnAnimation })
            }
            ariaLabel={t("settings.pageTurnAnimation")}
          />
        </div>
      </div>
    </>
  );
}
