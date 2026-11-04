import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { Book } from "@/core/library";
import type { CloudShelf } from "@/components/sync/use-sync";
import { CloudArrowDown, DownloadSimple } from "@/components/ui/icons";
import { ProgressBar } from "@/components/ui/progress-bar";
import { ProgressRing } from "@/components/ui/progress-ring";
import { formatBytes } from "@/lib/format";
import { BookCover, CoverFrame } from "./book-cover";
import { GRID_CLASSES } from "./library-grid";

// "On your other devices": books this device doesn't hold — in the cloud
// (manga kept there, big files; small novels arrive on their own) or only
// on another device, which sends them straight over the Wi-Fi. A tap
// downloads the book and opens it; while it comes in, the cover frosts and
// counts up, and a direct transfer says where it stands — calling the other
// device, asking for yuki to be opened there when it doesn't answer,
// connecting, with a bar along the cover as the bytes come. A volume still
// being recognized on its device can't come yet: its cover dims under a
// ring with that device's real progress — the same look as a volume
// being processed on this shelf — and a tap does nothing until it's ready.
// Same grid and tile rhythm as the shelf, so the section reads as more of
// the library, not a separate place.

export function CloudSection({ cloud }: { cloud: CloudShelf }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [failed, setFailed] = useState<string | null>(null);
  if (cloud.books.length === 0) return null;

  const open = (key: string, title: string, device: string) => {
    setFailed(null);
    void cloud.download(key).then(
      (id) => {
        if (id) navigate(`/read/${id}`);
      },
      (error: unknown) => {
        setFailed(key);
        // By name: the error classes live in the lazily loaded sync code.
        const reason = error instanceof Error ? error.name : "";
        if (reason === "PeerUnavailableError") toast(t("library.cloud.unanswered", { device }));
        else if (reason === "PeerUnreachableError") toast(t("library.cloud.unreachable", { device }));
        else toast(t("library.cloud.failed", { title }));
      },
    );
  };

  return (
    <section data-cloud-shelf="" className="mt-10">
      <h2 className="mb-4 text-sm text-default tabular-nums">
        {t("library.cloud.title")} · {cloud.books.length}
      </h2>
      <div className={GRID_CLASSES}>
        {cloud.books.map(({ key, desc, from, preparing }) => {
          // The cover pieces speak Book: a cloud book pretends to be one.
          const pseudo: Book = {
            id: key,
            title: desc.title,
            progress: 0,
            addedAt: 0,
            format: desc.format,
            ...(desc.author ? { author: desc.author } : {}),
            ...(desc.cover ? { cover: desc.cover } : {}),
          };
          const progress = cloud.downloads[key];
          const busy = progress !== undefined;
          const waiting = preparing !== undefined && !busy;
          const stage = from ? cloud.direct[key] : undefined;
          const subtitle =
            desc.format === "manga" && desc.volumeIndex !== undefined
              ? `${desc.series ?? ""} · ${t("manga.volume", { index: desc.volumeIndex })}`
              : (desc.author ?? " ");
          // Just "Mac" / "iPhone": the browser's name would push the size off
          // a phone-width tile.
          const device = from ? t(`sync.platform.${from.platform}`) : "";
          const source = from ? t("library.cloud.from", { device }) : t("library.cloud.inCloud");
          return (
            <button
              key={key}
              type="button"
              data-cloud-book={key}
              data-cloud-from={from ? "device" : "cloud"}
              data-cloud-prep={waiting ? preparing : undefined}
              aria-label={t(waiting ? "library.cloud.preparing" : "library.cloud.download", { title: desc.title })}
              aria-busy={busy || waiting || undefined}
              disabled={busy || waiting}
              onClick={() => open(key, desc.title, device)}
              className="group flex w-full cursor-pointer flex-col text-left disabled:cursor-default"
            >
              <CoverFrame book={pseudo}>
                <div className={busy || waiting ? "opacity-60" : "opacity-80 transition-opacity group-hover:opacity-100"}>
                  <BookCover book={pseudo} />
                </div>
                {waiting ? (
                  <div className="absolute inset-0 grid place-items-center rounded-media bg-black/45 backdrop-blur-[2px]">
                    <ProgressRing value={preparing} className="size-8" />
                  </div>
                ) : busy ? (
                  stage ? null : (
                    <ProgressBar value={progress} tone="media" label={desc.title} className="absolute inset-x-2 bottom-2" />
                  )
                ) : (
                  <span
                    className={`absolute bottom-1.5 right-1.5 grid size-8 place-items-center rounded-full bg-scrim text-white ${
                      failed === key ? "ring-2 ring-destructive" : ""
                    }`}
                  >
                    {from ? <DownloadSimple className="size-4" /> : <CloudArrowDown className="size-4" />}
                  </span>
                )}
                {stage ? (
                  <span
                    data-cloud-stage={stage}
                    aria-live="polite"
                    className="absolute inset-x-1.5 top-1.5 rounded-pane bg-scrim px-2 py-1.5 text-center text-xs text-white"
                  >
                    {t(`library.cloud.${stage}`, { device })}
                  </span>
                ) : null}
              </CoverFrame>
              <p className="mt-3 truncate text-sm text-strong" title={desc.title}>
                {desc.title}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-content">{subtitle}</p>
              <p className="mt-0.5 truncate text-xs text-muted-content tabular-nums">
                {busy && !stage
                  ? `${Math.round(progress * 100)}%${desc.size > 0 ? ` · ${formatBytes(desc.size)}` : ""}`
                  : desc.size > 0
                    ? `${source} · ${formatBytes(desc.size)}`
                    : source}
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
