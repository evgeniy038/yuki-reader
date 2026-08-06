import { useTranslation } from "react-i18next";
import {
  FONT_OPTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
  FONT_WEIGHT_MAX,
  FONT_WEIGHT_MIN,
  FONT_WEIGHT_STEP,
  THEME_SEGMENTS,
  clampFontSize,
  clampFontWeight,
  type ReadingSettings,
} from "@/core/reading-settings";
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

// The reading typography controls, shared by the settings page and the
// reader's quick settings popover. Both change the same ReadingSettings the
// same way; only the surrounding layout (settings row vs popover stack) and
// a couple of labels differ, so those stay with the callers.

interface FontControlProps {
  settings: ReadingSettings;
  onSettingsChange: (settings: ReadingSettings) => void;
}

export function ThemeControl({ settings, onSettingsChange }: FontControlProps) {
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
    <SegmentedControl
      segments={themeSegments}
      value={settings.theme}
      onChange={(theme) => onSettingsChange({ ...settings, theme })}
      ariaLabel={t("settings.themeAria")}
    />
  );
}

export function FontFamilyControl({
  settings,
  onSettingsChange,
  triggerClassName,
}: FontControlProps & {
  /** Sizing of the trigger: the settings page right-aligns it, the popover
      stretches it full width. */
  triggerClassName: string;
}) {
  const { t } = useTranslation();
  return (
    <Select
      value={settings.fontFamily}
      onValueChange={(fontFamily) => {
        const option = FONT_OPTIONS.find((item) => item.value === fontFamily);
        if (option) {
          onSettingsChange({ ...settings, fontFamily: option.value });
        }
      }}
    >
      <SelectTrigger
        aria-label={t("settings.fontAria")}
        className={triggerClassName}
      >
        <SelectValue>
          {(fontFamily: string) =>
            FONT_OPTIONS.find((option) => option.value === fontFamily)?.label ??
            fontFamily
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {FONT_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function FontWeightControl({
  settings,
  onSettingsChange,
}: FontControlProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3">
      <Slider
        value={settings.fontWeight}
        onValueChange={(fontWeight) =>
          onSettingsChange({
            ...settings,
            fontWeight: clampFontWeight(fontWeight),
          })
        }
        min={FONT_WEIGHT_MIN}
        max={FONT_WEIGHT_MAX}
        step={FONT_WEIGHT_STEP}
        ariaLabel={t("settings.weightAria")}
      />
      <span className="w-9 text-right text-sm text-default tabular-nums">
        {settings.fontWeight}
      </span>
    </div>
  );
}

export function FontSizeControl({
  settings,
  onSettingsChange,
  decreaseLabel,
  increaseLabel,
}: FontControlProps & {
  decreaseLabel: string;
  increaseLabel: string;
}) {
  return (
    <Stepper
      value={settings.fontSize}
      onStep={(delta) =>
        onSettingsChange({
          ...settings,
          fontSize: clampFontSize(settings.fontSize + delta * FONT_SIZE_STEP),
        })
      }
      canDecrement={settings.fontSize > FONT_SIZE_MIN}
      canIncrement={settings.fontSize < FONT_SIZE_MAX}
      decreaseLabel={decreaseLabel}
      increaseLabel={increaseLabel}
    />
  );
}
