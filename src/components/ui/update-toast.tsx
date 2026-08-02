import { useRegisterSW } from "virtual:pwa-register/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

// A fresh deploy never interrupts the reader: the new service worker waits
// in the background, and this quiet card offers to apply it now (a reload).
// No dismiss button — closing the app applies the update on the next visit.
// Offline readiness is not announced — it is the default state of the app
// after the first visit.
export function UpdateToast() {
  const { t } = useTranslation();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  const apply = () => {
    void updateServiceWorker(true);
    // A stale tab can lose its waiting worker — the browser activates it on
    // its own once every other app tab closes, and skipWaiting then no-ops
    // with no controlling event ever coming: the button looks dead. A plain
    // reload always lands on the newest active worker, so force one when the
    // normal path didn't fire promptly.
    window.setTimeout(() => window.location.reload(), 2500);
  };

  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 animate-in fade-in-0 slide-in-from-bottom-2 duration-150">
      <div className="flex items-center gap-4 rounded-card bg-raised px-4 py-3 shadow-floating">
        <p className="text-sm text-strong">{t("toast.updateReady")}</p>
        <Button size="sm" onClick={apply}>
          {t("toast.update")}
        </Button>
      </div>
    </div>
  );
}
