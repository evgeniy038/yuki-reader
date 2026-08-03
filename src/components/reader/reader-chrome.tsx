import { useEffect, useRef, useState } from "react";
import { CaretDown, CaretLeft, CornersOut, Gear, List, MagnifyingGlass } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFullscreen } from "@/lib/use-fullscreen";
import type { ReadingSettings } from "@/core/reading-settings";
import type { ReaderPanelMode } from "./reader-panel";
import { ReaderSettingsPopover } from "./reader-settings-popover";

const PILL_HIDE_MS = 1000;
const HANDLE_HIDE_MS = 2000;
const REVEAL_ZONE_PX = 64;
const FULLSCREEN_REVEAL_ZONE_PX = 64;

// Auto-hiding control pill (mac-dock style): appears when the cursor nears the
// top edge, taps the pull handle, or hovers the pill, slides away otherwise.
// Holds exit / panels / settings / fullscreen. The settings popover is a
// separate component — controlled via settingsOpen when passed, otherwise the
// chrome owns the flag (an open popover pins the pill visible).
// Everything here is ABSOLUTE inside the reader root (relative, exactly
// viewport-sized): no fixed-position layers in the chrome at all.
// FULLSCREEN: the top strip of the screen belongs to the system — the macOS
// menu bar (~33px, and Chrome's own exit control) drops over the page's top
// while the cursor is up there, and hits in that strip go to the system, not
// the page. So in fullscreen the pill parks just BELOW the bar (44px) and the
// reveal zone starts under it — the cursor never has to touch the top edge.
// The pull handle stays at the very top: when the bar is down it's covered
// (invisible, untargetable anyway); the rest of the time it works.
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
  settingsOpen: settingsOpenProp,
  onSettingsOpenChange,
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
  /** Controlled popover flag; the chrome keeps its own when omitted. */
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
}) {
  const [pillVisible, setPillVisible] = useState(true);
  const [handleVisible, setHandleVisible] = useState(false);
  const [settingsOpenInternal, setSettingsOpenInternal] = useState(false);
  const settingsOpen = settingsOpenProp ?? settingsOpenInternal;
  const { t } = useTranslation();
  const hovering = useRef(false);
  const chromeRef = useRef<HTMLDivElement>(null);
  const pillVisibleRef = useRef(true);
  const settingsOpenRef = useRef(false);
  const pillHideTimer = useRef<number | undefined>(undefined);
  const handleHideTimer = useRef<number | undefined>(undefined);
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

  const scheduleHandleHide = () => {
    if (handleHideTimer.current) window.clearTimeout(handleHideTimer.current);
    handleHideTimer.current = window.setTimeout(() => {
      setHandleVisible(false);
    }, HANDLE_HIDE_MS);
  };
  const hidePill = (force = false) => {
    if (
      !pillVisibleRef.current ||
      (!force && (hovering.current || settingsOpenRef.current))
    )
      return;
    pillVisibleRef.current = false;
    setPillVisible(false);
    setHandleVisible(true);
    scheduleHandleHide();
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
    if (handleHideTimer.current) window.clearTimeout(handleHideTimer.current);
    pillVisibleRef.current = true;
    setPillVisible(true);
    setHandleVisible(false);
    if (!hovering.current && !settingsOpenRef.current) schedulePillHide();
  };

  const setSettingsOpen = (open: boolean) => {
    if (settingsOpenProp === undefined) setSettingsOpenInternal(open);
    onSettingsOpenChange?.(open);
    if (open) showPill();
    else schedulePillHide();
  };

  useEffect(() => {
    schedulePillHide();
    const onMove = (event: MouseEvent) => {
      // Fullscreen: reveal from a compact zone hugging the parked pill — the
      // cursor never has to enter the system-owned top strip.
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
      if (handleHideTimer.current)
        window.clearTimeout(handleHideTimer.current);
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, []);

  const toggleSettings = () => {
    const open = !settingsOpen;
    if (open) onPanelChange?.(null);
    setSettingsOpen(open);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.();
    else void document.exitFullscreen?.();
  };

  return (
    <div ref={chromeRef}>
      <button
        type="button"
        onMouseEnter={showPill}
        onClick={showPill}
        aria-label={t("reader.showControls")}
        title={t("reader.showControls")}
        tabIndex={handleVisible ? 0 : -1}
        className={cn(
          "absolute left-1/2 top-0 z-40 flex -translate-x-1/2 cursor-pointer items-center justify-center rounded-b-md border border-t-0 border-subtle bg-raised px-2.5 pb-0.5 text-muted-content shadow-floating transition-opacity duration-200 hover:text-strong",
          handleVisible
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
        <CaretDown weight="bold" className="size-3" />
      </button>

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
          fullscreen ? "top-11" : "top-3",
          pillVisible
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-3 opacity-0",
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          shape="round"
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
            onClick={() => onPanelChange?.(panel === "toc" ? null : "toc")}
            title={t("reader.toc")}
            aria-label={t("reader.toc")}
            aria-pressed={panel === "toc"}
          >
            <List />
          </Button>
        ) : null}
        {showSearch ? (
          <Button
            variant="ghost"
            size="icon-sm"
            shape="round"
            onClick={() => onPanelChange?.(panel === "search" ? null : "search")}
            title={t("reader.search")}
            aria-label={t("reader.search")}
            aria-pressed={panel === "search"}
          >
            <MagnifyingGlass />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          shape="round"
          onClick={toggleSettings}
          title={t("reader.settings")}
          aria-label={t("reader.settings")}
          aria-pressed={settingsOpen}
        >
          <Gear />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          shape="round"
          onClick={toggleFullscreen}
          title={t("reader.fullscreen")}
          aria-label={t("reader.fullscreen")}
        >
          <CornersOut />
        </Button>
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
