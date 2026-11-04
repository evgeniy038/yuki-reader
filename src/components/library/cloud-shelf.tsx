import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { Book } from "@/core/library";
import type { CloudShelf } from "@/components/sync/use-sync";
import { CloudArrowDown } from "@/components/ui/icons";
import { formatBytes } from "@/lib/format";
import { BookCover, CoverFrame } from "./book-cover";
import { GRID_CLASSES } from "./library-grid";

// "In the cloud": books another device uploaded that aren't on this one yet
// (manga volumes and big files — small novels arrive on their own). A tap
// downloads the book and opens it; while it comes in, the cover frosts and
// counts up. Same grid and tile rhythm as the shelf, so the section reads
// as more of the library, not a separate place.

export function CloudSection({ cloud }: { cloud: CloudShelf }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [failed, setFailed] = useState<string | null>(null);
  if (cloud.books.length === 0) return null;

  const open = (key: string, title: string) => {
    setFailed(null);
    void cloud.download(key).then(
      (id) => {
        if (id) navigate(`/read/${id}`);
      },
      () => {
        setFailed(key);
        toast(t("library.cloud.failed", { title }));
      },
    );
  };

  return (
    <section data-cloud-shelf="" className="mt-10">
      <h2 className="mb-4 text-sm text-default tabular-nums">
        {t("library.cloud.title")} · {cloud.books.length}
      </h2>
      <div className={GRID_CLASSES}>
        {cloud.books.map(({ key, desc }) => {
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
          const subtitle =
            desc.format === "manga" && desc.volumeIndex !== undefined
              ? `${desc.series ?? ""} · ${t("manga.volume", { index: desc.volumeIndex })}`
              : (desc.author ?? " ");
          return (
            <button
              key={key}
              type="button"
              data-cloud-book={key}
              aria-label={t("library.cloud.download", { title: desc.title })}
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={() => open(key, desc.title)}
              className="group flex w-full cursor-pointer flex-col text-left disabled:cursor-default"
            >
              <CoverFrame book={pseudo}>
                <div className={busy ? "opacity-60" : "opacity-80 transition-opacity group-hover:opacity-100"}>
                  <BookCover book={pseudo} />
                </div>
                <span
                  className={`absolute bottom-1.5 right-1.5 grid size-8 place-items-center rounded-full bg-scrim text-white ${
                    failed === key ? "ring-2 ring-destructive" : ""
                  }`}
                >
                  {busy ? (
                    <span className="text-xs tabular-nums">{Math.round(progress * 100)}%</span>
                  ) : (
                    <CloudArrowDown className="size-4" />
                  )}
                </span>
              </CoverFrame>
              <p className="mt-3 truncate text-sm text-strong" title={desc.title}>
                {desc.title}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-content">{subtitle}</p>
              <p className="mt-0.5 truncate text-xs text-muted-content tabular-nums">
                {formatBytes(desc.size)}
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
