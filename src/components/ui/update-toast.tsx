import { useRegisterSW } from "virtual:pwa-register/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

// A fresh deploy never interrupts the reader: the new service worker waits
// in the background, and this quiet card offers to apply it now (a reload)
// or later (the next natural visit). Offline readiness is not announced —
// it is the default state of the app after the first visit.
export function UpdateToast() {
  const { t } = useTranslation();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 animate-in fade-in-0 slide-in-from-bottom-2 duration-150">
      <div className="flex items-center gap-4 rounded-card bg-raised px-4 py-3 shadow-floating">
        <p className="text-sm text-strong">{t("toast.updateReady")}</p>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setNeedRefresh(false)}
          >
            {t("toast.later")}
          </Button>
          <Button size="sm" onClick={() => void updateServiceWorker(true)}>
            {t("toast.update")}
          </Button>
        </div>
      </div>
    </div>
  );
}
