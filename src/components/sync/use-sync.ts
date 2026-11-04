import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import i18n from "@/lib/i18n";
import { useLatest } from "@/lib/use-latest";
import type { Book } from "@/core/library";
import { loadReadingSettings, type ReadingSettings } from "@/core/reading-settings";
import type { OpenedData } from "@/components/library/use-shelf";
import type { SyncHost } from "./sync-bridge";
import { deviceLabel } from "./sync-labels";
import { isAuthRedirect, syncEnabled } from "./sync-signal";

type Controller = typeof import("./sync-controller");

interface SyncDeps {
  books: Book[];
  shelfReady: boolean;
  setBooks: Dispatch<SetStateAction<Book[]>>;
  dataRef: { current: Map<string, OpenedData> };
  removeBook: (id: string) => void;
  readingSettings: ReadingSettings;
  setReadingSettings: Dispatch<SetStateAction<ReadingSettings>>;
  openedBook: Book | undefined;
}

// App-level sync wiring. The controller (engine, crypto, providers) is
// imported only on a device that syncs or on a provider's OAuth return —
// everyone else never downloads a byte of it. Any change to the shelf or
// the reading settings schedules a round (debounced); the controller adds
// the open/return/online/minute triggers itself. Returns a key that remounts
// the reader when the "continue from 45% · iPhone" offer is taken.
export function useSync(deps: SyncDeps): { readerKey: number } {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const latest = useLatest(deps);
  const controller = useRef<Controller | null>(null);
  const [readerKey, setReaderKey] = useState(0);

  useEffect(() => {
    const redirect = isAuthRedirect(window.location.search);
    if (!redirect && !syncEnabled()) return;
    let alive = true;
    let detach = () => {};
    const host: SyncHost = {
      ready: () => latest.current.shelfReady,
      books: () => latest.current.books,
      patch: (patches) => {
        const byId = new Map(patches.map((patch) => [patch.id, patch]));
        latest.current.setBooks((prev) =>
          prev.map((book) => {
            const patch = byId.get(book.id);
            if (!patch) return book;
            const next = { ...book };
            if (patch.progress !== undefined) next.progress = patch.progress;
            if (patch.lastReadAt !== undefined) next.lastReadAt = patch.lastReadAt;
            if (patch.favorite !== undefined) next.favorite = patch.favorite;
            if (patch.series !== undefined) next.series = patch.series ?? undefined;
            if (patch.volumeIndex !== undefined) next.volumeIndex = patch.volumeIndex ?? undefined;
            if (patch.title !== undefined) {
              next.title = patch.title;
              const data = latest.current.dataRef.current.get(book.id);
              if (data) data.metadata = { ...data.metadata, title: patch.title };
            }
            return next;
          }),
        );
      },
      remove: (ids) => {
        for (const id of ids) latest.current.removeBook(id);
      },
      settingsApplied: (applied) => {
        if (applied.reading) latest.current.setReadingSettings(loadReadingSettings());
        if (applied.lang) void i18n.changeLanguage(applied.lang);
      },
    };
    void import("./sync-controller").then(async (sync) => {
      if (!alive) return;
      controller.current = sync;
      detach = sync.attachHost(host);
      await sync.init();
      if (redirect) {
        const search = window.location.search;
        // Drop ?code=… from the address bar before anything else.
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
        await sync.completeRedirect(search);
        navigate("/settings");
      }
      sync.startTriggers();
      void sync.syncNow();
    });
    return () => {
      alive = false;
      detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Edits come in bursts while reading: any shelf or settings change asks for
  // a round a little later; the round itself reads the then-current state.
  useEffect(() => {
    if (deps.shelfReady) controller.current?.requestSync();
  }, [deps.books, deps.readingSettings, deps.shelfReady]);

  // Opening a book: offer the furthest place another device really read.
  const openedId = deps.openedBook?.id;
  useEffect(() => {
    const sync = controller.current;
    const book = latest.current.openedBook;
    if (!sync || !book) return;
    let alive = true;
    void sync.offerFor(book.id, book.progress).then((offer) => {
      if (!alive || !offer) return;
      toast(
        t("sync.offer", { percent: Math.round(offer.p * 100), device: deviceLabel(t, offer.device) }),
        {
          duration: 12_000,
          action: {
            label: t("sync.offerJump"),
            onClick: () => {
              void sync.jumpTo(book.id, offer.p).then(() => setReaderKey((key) => key + 1));
            },
          },
        },
      );
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedId]);

  return { readerKey };
}
