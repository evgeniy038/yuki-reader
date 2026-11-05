import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import i18n from "@/lib/i18n";
import { useLatest } from "@/lib/use-latest";
import type { Book } from "@/core/library";
import type { PackDesc } from "@/core/sync/book-pack";
import type { DeviceInfo } from "@/core/sync/model";
import { loadReadingSettings, type ReadingSettings } from "@/core/reading-settings";
import type { OpenedData } from "@/components/library/use-shelf";
import type { DirectStage } from "./p2p";
import type { SyncHost } from "./sync-bridge";
import { deviceLabel } from "./sync-labels";
import { isAuthRedirect, syncEnabled } from "./sync-signal";

type Controller = typeof import("./sync-controller");
type Actions = typeof import("./sync-actions");
type Cloud = typeof import("./sync-cloud");

/** The shelf's view of the cloud (empty while sync is off). */
export interface CloudShelf {
  /** `from`: not in the cloud — comes straight from that device.
      `preparing`: still being processed there, 0..1 — not downloadable yet. */
  books: { key: string; desc: PackDesc; from?: DeviceInfo; preparing?: number }[];
  /** content key → 0..1 */
  downloads: Record<string, number>;
  /** Direct transfers before their first byte: ringing, closed, connecting. */
  direct: Record<string, DirectStage>;
  /** Local ids that can leave this device and stay in the cloud. */
  inCloud: ReadonlySet<string>;
  /** Resolves to the downloaded book's id (null: already on its way). */
  download: (key: string) => Promise<string | null>;
  removeDownload: (id: string) => void;
}

const NO_CLOUD: CloudShelf["inCloud"] = new Set();

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
export function useSync(deps: SyncDeps): { readerKey: number; cloud: CloudShelf; busy: boolean } {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const latest = useLatest(deps);
  const controller = useRef<Controller | null>(null);
  const actions = useRef<Actions | null>(null);
  const cloudModule = useRef<Cloud | null>(null);
  const [readerKey, setReaderKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cloudView, setCloudView] = useState<Pick<CloudShelf, "books" | "downloads" | "direct" | "inCloud">>({
    books: [],
    downloads: {},
    direct: {},
    inCloud: NO_CLOUD,
  });

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
            if (patch.keep !== undefined) next.keepInCloud = patch.keep;
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
      add: (book) => {
        latest.current.setBooks((prev) => (prev.some((b) => b.id === book.id) ? prev : [book, ...prev]));
      },
      settingsApplied: (applied) => {
        if (applied.reading) latest.current.setReadingSettings(loadReadingSettings());
        if (applied.lang) void i18n.changeLanguage(applied.lang);
      },
    };
    let unsubscribe = () => {};
    void Promise.all([import("./sync-controller"), import("./sync-actions"), import("./sync-cloud")]).then(async ([sync, post, cloud]) => {
      if (!alive) return;
      controller.current = sync;
      actions.current = post;
      cloudModule.current = cloud;
      let last: ReturnType<typeof sync.getView> | null = null;
      const mirror = () => {
        const view = sync.getView();
        // Busy: a round is on, or a book is moving either way.
        setBusy(view.syncing || Object.keys(view.downloads).length > 0 || Object.keys(view.uploads).length > 0);
        if (
          last &&
          last.cloud === view.cloud &&
          last.downloads === view.downloads &&
          last.direct === view.direct &&
          last.inCloud === view.inCloud
        )
          return;
        last = view;
        setCloudView({ books: view.cloud, downloads: view.downloads, direct: view.direct, inCloud: new Set(view.inCloud) });
      };
      unsubscribe = sync.subscribe(mirror);
      mirror();
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
      unsubscribe();
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
    const sync = actions.current;
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

  const cloud: CloudShelf = {
    ...cloudView,
    download: async (key) => (cloudModule.current ? cloudModule.current.download(key) : null),
    removeDownload: (id) => {
      void cloudModule.current?.removeDownload(id);
    },
  };
  return { readerKey, cloud, busy };
}
