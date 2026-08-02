import {
  FONT_SEGMENTS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
  THEME_SEGMENTS,
  clampFontSize,
  type ReadingSettings,
} from "@/core/reading-settings";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";

// The reader's quick settings popover: reading theme always (it recolors PDF
// pages too), font controls only for the text reader — PDF pages are images
// of print, font settings don't apply there. An invisible backdrop swallows
// outside clicks; Escape closes.
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
  const themeSegments = THEME_SEGMENTS.map((segment) => ({
    value: segment.value,
    label: {
      light: t("settings.themeLight"),
      sepia: t("settings.themeSepia"),
      dark: t("settings.themeDark"),
    }[segment.value],
  }));

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
          "pointer-events-auto absolute left-1/2 z-40 flex w-64 origin-top -translate-x-1/2 animate-in flex-col gap-3 rounded-card border border-subtle bg-raised p-3 shadow-floating fade-in-0 zoom-in-95 duration-100",
          fullscreen ? "top-24" : "top-16",
        )}
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-content">{t("settings.theme")}</span>
          <SegmentedControl
            segments={themeSegments}
            value={settings.theme}
            onChange={(theme) => onSettingsChange({ ...settings, theme })}
            ariaLabel={t("settings.themeAria")}
          />
        </div>
        {showFontSettings ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-content">{t("settings.font")}</span>
              <SegmentedControl
                segments={FONT_SEGMENTS}
                value={settings.fontFamily}
                onChange={(fontFamily) =>
                  onSettingsChange({ ...settings, fontFamily })
                }
                ariaLabel={t("settings.fontAria")}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-content">{t("settings.size")}</span>
              <div className="flex justify-center">
                <Stepper
                  value={settings.fontSize}
                  onStep={(delta) =>
                    onSettingsChange({
                      ...settings,
                      fontSize: clampFontSize(
                        settings.fontSize + delta * FONT_SIZE_STEP,
                      ),
                    })
                  }
                  canDecrement={settings.fontSize > FONT_SIZE_MIN}
                  canIncrement={settings.fontSize < FONT_SIZE_MAX}
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
      </div>
    </>
  );
}
