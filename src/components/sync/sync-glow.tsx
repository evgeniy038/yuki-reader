import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// "Something is syncing": a thin light running along the top edge of the
// screen, on every screen, the reader included — present enough to notice,
// quiet enough to read under. It waits SHOW_AFTER_MS before appearing, so
// the everyday one-second round never flashes it, and once shown it stays
// at least STAY_MS, so a round that ends just after never blinks. Reduced
// motion: the light holds still.

const SHOW_AFTER_MS = 600;
const STAY_MS = 500;

export function SyncGlow({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const [since, setSince] = useState(0);

  useEffect(() => {
    if (active && !shown) {
      const timer = window.setTimeout(() => {
        setShown(true);
        setSince(Date.now());
      }, SHOW_AFTER_MS);
      return () => window.clearTimeout(timer);
    }
    if (!active && shown) {
      const timer = window.setTimeout(() => setShown(false), Math.max(0, since + STAY_MS - Date.now()));
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [active, shown, since]);

  return (
    <div
      data-sync-glow={shown ? "on" : "off"}
      role="status"
      aria-live="polite"
      className={`pointer-events-none fixed inset-x-0 top-safe-0 z-[60] transition-opacity duration-300 ${shown ? "opacity-100" : "opacity-0"}`}
    >
      <span className="sr-only">{shown ? t("settings.sync.syncing") : ""}</span>
      <div aria-hidden className="sync-glow h-0.5" />
      <div aria-hidden className="sync-glow -mt-0.5 h-2 opacity-50 blur-sm" />
    </div>
  );
}
