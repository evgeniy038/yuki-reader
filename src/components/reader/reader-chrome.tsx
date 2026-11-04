import { useEffect, useRef, useState } from "react";
import { CaretLeft, CornersOut, Gear, List, MagnifyingGlass } from "@/components/ui/icons";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFullscreen } from "@/lib/use-fullscreen";
import type { ReadingSettings } from "@/core/reading-settings";
import type { ReaderPanelMode } from "./reader-panel";
import { ReaderSettingsPopover } from "./reader-settings-popover";

const PILL_HIDE_MS = 1000;
// Edge-only reveal: a thin strip hugging the top edge. Text never lives
// there (page margin is far below), so scanning words near the top can't
// trip it — every reveal is a deliberate edge throw, which by Fitt's law is
// the easiest target on the screen.
const REVEAL_ZONE_PX = 10;
// Fullscreen: the edge is the system menu bar gesture — a few pixels are
// enough to catch the intent as the cursor arrives.
const FULLSCREEN_REVEAL_ZONE_PX = 4;

// Auto-hiding control pill (mac-dock style): reveals only when the cursor
// touches the very top edge — never from the page body, so hovering words at
// the top of a column (dictionary popups included) stays undisturbed. Holds
// exit / panels / settings / fullscreen. The settings popover is a separate
// component — controlled via settingsOpen (an open popover pins the pill
// visible).
// Everything here is ABSOLUTE inside the reader root (relative, exactly
// viewport-sized): no fixed-position layers in the chrome at all.
// FULLSCREEN: the top edge belongs to the system — touching it drops the
// macOS menu bar over the page while the cursor is up there. That is the
// same combined gesture Safari uses (bar + toolbar drop together), so the
// pill parks just BELOW the bar (44px) and reveals from the same edge touch.
// TOUCH: there is no cursor to throw at an edge — `touchVisible` (the
// reader's middle-band tap) holds the pill up until the next tap or page
// turn, buttons grow to finger size, and the pill clears the status bar.
// Fullscreen only shows where the browser can do it (not on iPhone).
export function ReaderChrome({
  onExit,
  settings,
  onSettingsChange,
  showFontSettings = true,
  showSearch = true,
  tocAvailable = false,
  panel = null,
  onPanelChange,
  showMangaSettings = false,
  mangaFirstPageAsCover = true,
  onMangaFirstPageAsCoverChange,
  settingsOpen,
  onSettingsOpenChange,
  touchVisible = false,
}: {
  onExit: () => void;
  settings: ReadingSettings;
  onSettingsChange: (settings: ReadingSettings) => void;
  showFontSettings?: boolean;
  /** Search button shows only where there's text to search. */
  showSearch?: boolean;
  /** TOC button shows only when the book actually has an outline. */
  tocAvailable?: boolean;
  panel?: ReaderPanelMode;
  onPanelChange?: (panel: ReaderPanelMode) => void;
  showMangaSettings?: boolean;
  mangaFirstPageAsCover?: boolean;
  onMangaFirstPageAsCoverChange?: (checked: boolean) => void;
  /** Controlled popover flag (an open popover pins the pill visible). */
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  /** Touch controls are up (middle-band tap) — the pill stays shown. */
  touchVisible?: boolean;
}) {
  const [pillVisible, setPillVisible] = useState(true);
  const { t } = useTranslation();
  const hovering = useRef(false);
  const chromeRef = useRef<HTMLDivElement>(null);
  const pillVisibleRef = useRef(true);
  const settingsOpenRef = useRef(false);
  const pillHideTimer = useRef<number | undefined>(undefined);
  // In fullscreen the top strip is the system's (see the header comment):
  // the pill drops below it and reveals from a lower zone.
  const fullscreen = useFullscreen();
  const fullscreenRef = useRef(false);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  useEffect(() => {
    fullscreenRef.current = fullscreen;
  }, [fullscreen]);

  const hidePill = (force = false) => {
    if (
      !pillVisibleRef.current ||
      (!force && (hovering.current || settingsOpenRef.current))
    )
      return;
    pillVisibleRef.current = false;
    setPillVisible(false);
  };
  const schedulePillHide = () => {
    if (pillHideTimer.current) window.clearTimeout(pillHideTimer.current);
    pillHideTimer.current = window.setTimeout(() => {
      pillHideTimer.current = undefined;
      hidePill();
    }, PILL_HIDE_MS);
  };
  const showPill = () => {
    if (pillHideTimer.current) window.clearTimeout(pillHideTimer.current);
    pillVisibleRef.current = true;
    setPillVisible(true);
    if (!hovering.current && !settingsOpenRef.current) schedulePillHide();
  };

  const setSettingsOpen = (open: boolean) => {
    onSettingsOpenChange(open);
    if (open) showPill();
    else schedulePillHide();
  };

  useEffect(() => {
    schedulePillHide();
    const onMove = (event: MouseEvent) => {
      const revealY = fullscreenRef.current
        ? FULLSCREEN_REVEAL_ZONE_PX
        : REVEAL_ZONE_PX;
      if (event.clientY < revealY) showPill();
      else if (!hovering.current) schedulePillHide();
    };
    const onDocumentClick = (event: MouseEvent) => {
      if (settingsOpenRef.current) return;
      const target = event.target;
      if (!(target instanceof Node) || !chromeRef.current?.contains(target)) {
        hidePill(true);
      }
    };
    window.addEventListener("mousemove", onMove);
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      if (pillHideTimer.current) window.clearTimeout(pillHideTimer.current);
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, []);

  const toggleSettings = () => {
    const open = !settingsOpen;
    if (open) onPanelChange?.(null);
    setSettingsOpen(open);
  };

  const canFullscreen =
    typeof document !== "undefined" && document.fullscreenEnabled === true;
  const shown = pillVisible || touchVisible || settingsOpen;
  const buttonSize = "pointer-coarse:size-10";

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.();
    else void document.exitFullscreen?.();
  };

  return (
    <div ref={chromeRef}>
      <div
        onMouseEnter={() => {
          hovering.current = true;
          showPill();
        }}
        onMouseLeave={() => {
          hovering.current = false;
          schedulePillHide();
        }}
        className={cn(
          "absolute left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-pill border border-subtle bg-raised p-1 shadow-floating transition-[transform,opacity] duration-200",
          fullscreen ? "top-11" : "top-safe-3",
          shown
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-3 opacity-0",
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          shape="round"
          className={buttonSize}
          onClick={onExit}
          title={t("reader.back")}
          aria-label={t("reader.back")}
        >
          <CaretLeft />
        </Button>
        {tocAvailable ? (
          <Button
            variant="ghost"
            size="icon-sm"
            shape="round"
            className={buttonSize}
            onClick={() => onPanelChange?.(panel === "toc" ? null : "toc")}
            title={t("reader.toc")}
            aria-label={t("reader.toc")}
            aria-pressed={panel === "toc"}
          >
            <List filled={panel === "toc"} />
          </Button>
        ) : null}
        {showSearch ? (
          <Button
            variant="ghost"
            size="icon-sm"
            shape="round"
            className={buttonSize}
            onClick={() => onPanelChange?.(panel === "search" ? null : "search")}
            title={t("reader.search")}
            aria-label={t("reader.search")}
            aria-pressed={panel === "search"}
          >
            <MagnifyingGlass filled={panel === "search"} />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          shape="round"
          className={buttonSize}
          onClick={toggleSettings}
          title={t("reader.settings")}
          aria-label={t("reader.settings")}
          aria-pressed={settingsOpen}
        >
          <Gear filled={settingsOpen} />
        </Button>
        {canFullscreen ? (
          <Button
            variant="ghost"
            size="icon-sm"
            shape="round"
            className={buttonSize}
            onClick={toggleFullscreen}
            title={t("reader.fullscreen")}
            aria-label={t("reader.fullscreen")}
          >
            <CornersOut />
          </Button>
        ) : null}
      </div>

      {settingsOpen ? (
        <ReaderSettingsPopover
          settings={settings}
          onSettingsChange={onSettingsChange}
          showFontSettings={showFontSettings}
          showMangaSettings={showMangaSettings}
          mangaFirstPageAsCover={mangaFirstPageAsCover}
          onMangaFirstPageAsCoverChange={onMangaFirstPageAsCoverChange}
          fullscreen={fullscreen}
          onClose={() => {
            setSettingsOpen(false);
            hidePill(true);
          }}
        />
      ) : null}
    </div>
  );
}
