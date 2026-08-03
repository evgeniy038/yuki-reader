import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  fontFamilyStack,
  readingTheme,
  type ReadingSettings,
} from "@/core/reading-settings";

type PreviewLanguage = "ja" | "en";

const PREVIEW_SEGMENTS: readonly {
  value: PreviewLanguage;
  label: string;
}[] = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

const JP_PREVIEW =
  "それは<ruby>静<rt>しず</rt></ruby>かな<ruby>夜<rt>よる</rt></ruby>だった。" +
  "<ruby>彼女<rt>かのじょ</rt></ruby>は<ruby>窓<rt>まど</rt></ruby>の" +
  "<ruby>外<rt>そと</rt></ruby>を<ruby>見<rt>み</rt></ruby>つめたまま、" +
  "<ruby>小<rt>ちい</rt></ruby>さくため<ruby>息<rt>いき</rt></ruby>をついた。" +
  "<ruby>雨<rt>あめ</rt></ruby>はもうやんでいて、<ruby>濡<rt>ぬ</rt></ruby>れた" +
  "<ruby>屋根<rt>やね</rt></ruby>の<ruby>上<rt>うえ</rt></ruby>には、" +
  "<ruby>遠<rt>とお</rt></ruby>くの<ruby>街<rt>まち</rt></ruby>の" +
  "<ruby>灯<rt>あか</rt></ruby>りだけが<ruby>揺<rt>ゆ</rt></ruby>れていた。" +
  "<ruby>夜<rt>よる</rt></ruby>はまだ、<ruby>誰<rt>だれ</rt></ruby>のものでもなかった。";

const EN_PREVIEW =
  "The evening was quiet. She kept watching the rain outside the window, " +
  "sighed softly, and closed her book without marking the page. She opened " +
  "the book again, found her place, and read on into the night.";

// Live preview of the reading settings: real text, same fonts and metrics as
// the reader (the .reading class carries the shared typography). Japanese
// renders vertically — that's how novels are actually read — English stays
// horizontal. Everything — the furigana/language header and the text — sits
// in one bordered inset pane inside the group card, and the group skips the
// hairline after it (the pane itself is the boundary). The pane has a FIXED
// height (h-56): changing a setting must never move the rows below; the
// samples are short enough to fit at sane settings, bigger ones just clip at
// the pane edge — no masks, they ate the glyphs. w-full is required because
// in vertical writing a block's width is the block axis and shrink-wraps by
// default. Page margins show at half scale — the preview is a scaled-down
// page. Furigana lives in the header: it is a Japanese-text setting, so it
// disables itself on the English sample.
export function ReadingPreview({
  settings,
  onFuriganaChange,
}: {
  settings: ReadingSettings;
  onFuriganaChange: (furigana: boolean) => void;
}) {
  const [language, setLanguage] = useState<PreviewLanguage>("ja");
  const { t } = useTranslation();
  const vertical = language === "ja";
  const theme = readingTheme(settings.theme);

  return (
    <div data-furigana={settings.furigana ? undefined : "off"}>
      <div className="rounded-pane border border-subtle p-3">
        <div className="mb-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Switch
              checked={settings.furigana}
              onCheckedChange={onFuriganaChange}
              ariaLabel={t("settings.furiganaAria")}
              disabled={!vertical}
            />
            <span
              className={cn(
                "text-sm",
                vertical ? "text-default" : "text-muted-content",
              )}
            >
              {t("settings.furigana")}
            </span>
          </div>
          <SegmentedControl
            segments={PREVIEW_SEGMENTS}
            value={language}
            onChange={setLanguage}
            ariaLabel={t("settings.previewLangAria")}
          />
        </div>
        <div
          className="reading h-56 w-full overflow-hidden rounded-sm"
          lang={language}
          style={
            {
              fontFamily: fontFamilyStack(settings.fontFamily),
              fontSize: `${settings.fontSize}px`,
              fontWeight: settings.fontWeight,
              lineHeight: settings.lineHeight,
              writingMode: vertical ? "vertical-rl" : "horizontal-tb",
              padding: `${Math.round(settings.pageMargin / 2)}px`,
              background: theme.bg,
              color: theme.text,
              "--reading-muted": theme.muted,
            } as CSSProperties
          }
          dangerouslySetInnerHTML={{
            __html: vertical ? JP_PREVIEW : EN_PREVIEW,
          }}
        />
      </div>
    </div>
  );
}
