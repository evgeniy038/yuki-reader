import { useEffect, useRef, useState } from "react";
import { CaretLeft, CornersOut, Gear, List, MagnifyingGlass } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReadingSettings } from "@/core/reading-settings";
import type { ReaderPanelMode } from "./reader-panel";
import { ReaderSettingsPopover } from "./reader-settings-popover";

// Auto-hiding control pill (mac-dock style): appears when the cursor nears the
// top edge or hovers the pill, slides away otherwise. Holds exit / panels /
// settings / fullscreen. The settings popover is a separate component — the
// chrome only owns its open flag (an open popover pins the pill visible).
export function ReaderChrome({
  onExit,
  settings,
  onSettingsChange,
  showFontSettings = true,
  showSearch = true,
  tocAvailable = false,
  panel = null,
  onPanelChange,
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
}) {
  const [visible, setVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { t } = useTranslation();
  const hovering = useRef(false);
  const settingsOpenRef = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  const show = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    setVisible(true);
  };
  const scheduleHide = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!hovering.current && !settingsOpenRef.current) setVisible(false);
    }, 1400);
  };

  useEffect(() => {
    const initial = window.setTimeout(() => scheduleHide(), 1800);
    const onMove = (event: MouseEvent) => {
      if (event.clientY < 40) show();
      else scheduleHide();
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.clearTimeout(initial);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.();
    else void document.exitFullscreen?.();
  };

  return (
    <>
      <div
        onMouseEnter={() => {
          hovering.current = true;
          show();
        }}
        onMouseLeave={() => {
          hovering.current = false;
          scheduleHide();
        }}
        className={cn(
          "fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-1 rounded-pill border border-subtle bg-raised p-1 shadow-floating transition-[transform,opacity] duration-200",
          visible
            ? "translate-y-0 opacity-100"
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
          onClick={() => setSettingsOpen((open) => !open)}
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
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}
