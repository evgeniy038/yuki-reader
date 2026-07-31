import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Stepper } from "@/components/ui/stepper";
import {
  FONT_SEGMENTS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_STEP,
  PAGE_MARGIN_MAX,
  PAGE_MARGIN_MIN,
  PAGE_MARGIN_STEP,
  THEME_SEGMENTS,
  clampFontSize,
  type ReadingSettings,
} from "@/core/reading-settings";
import {
  PageContent,
  PageHeader,
  PageShell,
  PageTitle,
} from "./page-shell";
import { SettingsBlock, SettingsGroup, SettingsRow } from "./settings-group";
import { ReadingPreview } from "./reading-preview";
import { AboutSection } from "./about-section";

interface SettingsPageProps {
  settings: ReadingSettings;
  onSettingsChange: (settings: ReadingSettings) => void;
}

const snap = (value: number, digits: number) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

// UI language options: language names in their own language (they must read
// native to whoever is looking for theirs).
const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
] as const;

// Settings as a page of macOS-style grouped cards (SettingsGroup). The reading
// group opens with a live preview (real JP/EN text) so every control below is
// testable in place. The reader keeps its own quick
// typography popover, where the result is visible on the text immediately.
export function SettingsPage({
  settings,
  onSettingsChange,
}: SettingsPageProps) {
  const { t } = useTranslation();
  const setFontSize = (fontSize: number) =>
    onSettingsChange({ ...settings, fontSize: clampFontSize(fontSize) });

  const themeSegments = THEME_SEGMENTS.map((segment) => ({
    value: segment.value,
    label: {
      light: t("settings.themeLight"),
      sepia: t("settings.themeSepia"),
      dark: t("settings.themeDark"),
    }[segment.value],
  }));

  return (
    <PageShell>
      <PageHeader>
        <PageTitle>{t("settings.title")}</PageTitle>
      </PageHeader>
      <PageContent className="mx-auto w-full max-w-lg gap-6">
        <SettingsGroup title={t("settings.general")}>
          <SettingsRow label={t("settings.language")}>
            <Select
              value={i18n.resolvedLanguage ?? "en"}
              onValueChange={(lng) => void i18n.changeLanguage(lng ?? "en")}
            >
              <SelectTrigger aria-label={t("settings.languageAria")}>
                <SelectValue>
                  {(lng: string) =>
                    LANGUAGE_OPTIONS.find((option) => option.value === lng)
                      ?.label ?? lng
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {LANGUAGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title={t("settings.reading")}>
          <SettingsBlock>
            <ReadingPreview
              settings={settings}
              onFuriganaChange={(furigana) =>
                onSettingsChange({ ...settings, furigana })
              }
            />
          </SettingsBlock>
          <SettingsRow label={t("settings.theme")}>
            <SegmentedControl
              segments={themeSegments}
              value={settings.theme}
              onChange={(theme) => onSettingsChange({ ...settings, theme })}
              ariaLabel={t("settings.themeAria")}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.font")}>
            <SegmentedControl
              segments={FONT_SEGMENTS}
              value={settings.fontFamily}
              onChange={(fontFamily) =>
                onSettingsChange({ ...settings, fontFamily })
              }
              ariaLabel={t("settings.fontAria")}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.size")}>
            <Stepper
              value={settings.fontSize}
              onStep={(delta) =>
                setFontSize(settings.fontSize + delta * FONT_SIZE_STEP)
              }
              canDecrement={settings.fontSize > FONT_SIZE_MIN}
              canIncrement={settings.fontSize < FONT_SIZE_MAX}
              decreaseLabel={t("settings.sizeDecrease")}
              increaseLabel={t("settings.sizeIncrease")}
            />
          </SettingsRow>
          <SettingsRow label={t("settings.lineHeight")}>
            <div className="flex items-center gap-3">
              <Slider
                value={settings.lineHeight}
                onValueChange={(lineHeight) =>
                  onSettingsChange({ ...settings, lineHeight: snap(lineHeight, 1) })
                }
                min={LINE_HEIGHT_MIN}
                max={LINE_HEIGHT_MAX}
                step={LINE_HEIGHT_STEP}
                ariaLabel={t("settings.lineHeightAria")}
              />
              <span className="w-9 text-right text-sm text-default tabular-nums">
                {settings.lineHeight.toFixed(1)}
              </span>
            </div>
          </SettingsRow>
          <SettingsRow label={t("settings.margin")}>
            <div className="flex items-center gap-3">
              <Slider
                value={settings.pageMargin}
                onValueChange={(pageMargin) =>
                  onSettingsChange({ ...settings, pageMargin })
                }
                min={PAGE_MARGIN_MIN}
                max={PAGE_MARGIN_MAX}
                step={PAGE_MARGIN_STEP}
                ariaLabel={t("settings.marginAria")}
              />
              <span className="w-9 text-right text-sm text-default tabular-nums">
                {settings.pageMargin}
              </span>
            </div>
          </SettingsRow>
        </SettingsGroup>
        <AboutSection />
      </PageContent>
    </PageShell>
  );
}
