import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { CaretLeft, DotsThree, FolderPlus, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { normalizeSeriesKey } from "@/core/mokuro";
import type { Book } from "@/core/library";
import type { MangaInputItem } from "@/core/import-manga";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { BookTile } from "./book-tile";
import { RenameDialog } from "./rename-dialog";
import {
  PageActions,
  PageContent,
  PageHeader,
  PageShell,
  PageTitle,
} from "./page-shell";

const NEW_SERIES = "__new__";

// The series page: one manga's volumes as a cover grid. Volumes sort by
// number; drag a tile onto another to reorder (positions persist as the
// volumes' numbers). The context menu carries volume actions — open, rename,
// move to another series, delete. "Add volume" imports straight INTO this
// series, whatever the file names say.
export function MangaPage({
  books,
  shelfReady,
  error,
  notice,
  onOpenBook,
  onRenameBook,
  onDeleteBook,
  onRenameSeries,
  onMoveVolume,
  onMoveSeries,
  onDeleteSeries,
  onReorder,
  onAddVolumes,
}: {
  books: Book[];
  shelfReady: boolean;
  error: string | null;
  notice: string | null;
  onOpenBook: (id: string) => void;
  onRenameBook: (id: string, title: string) => void;
  onDeleteBook: (id: string) => void;
  onRenameSeries: (series: string, next: string) => void;
  onMoveVolume: (id: string, series: string) => void;
  onMoveSeries: (fromSeries: string, toSeries: string) => void;
  onDeleteSeries: (series: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onAddVolumes: (items: MangaInputItem[], targetSeries: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { seriesKey = "" } = useParams();

  const volumes = useMemo(
    () =>
      books
        .filter(
          (book) =>
            book.format === "manga" &&
            book.series !== undefined &&
            normalizeSeriesKey(book.series) === seriesKey,
        )
        .sort(
          (a, b) =>
            (a.volumeIndex ?? Infinity) - (b.volumeIndex ?? Infinity) ||
            a.addedAt - b.addedAt,
        ),
    [books, seriesKey],
  );
  const seriesName = volumes[0]?.series ?? "";

  // Every series on the shelf (for the move dialog), minus this one.
  const otherSeries = useMemo(
    () =>
      [
        ...new Set(
          books
            .filter(
              (book) =>
                book.format === "manga" &&
                book.series !== undefined &&
                normalizeSeriesKey(book.series) !== seriesKey,
            )
            .map((book) => book.series!),
        ),
      ].sort((a, b) => a.localeCompare(b, "ja")),
    [books, seriesKey],
  );

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [renamingSeries, setRenamingSeries] = useState(false);
  const [movingSeries, setMovingSeries] = useState(false);
  const [deletingSeries, setDeletingSeries] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string>(NEW_SERIES);
  const [moveNewName, setMoveNewName] = useState("");
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // The last volume left (or a bad URL): nothing to show here.
  useEffect(() => {
    if (shelfReady && volumes.length === 0) navigate("/", { replace: true });
  }, [shelfReady, volumes.length, navigate]);

  if (volumes.length === 0) return null;

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0 || seriesName === "") return;
    onAddVolumes(
      files.map((file) => ({
        file,
        path:
          (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
          file.name,
      })),
      seriesName,
    );
  };

  const onDropTile = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    setDropIndex(null);
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    if (from === null || from === index) return;
    const ids = volumes.map((volume) => volume.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(index, 0, moved!);
    onReorder(ids);
  };

  return (
    <PageShell>
      <PageHeader>
        <Button
          variant="ghost"
          size="icon-sm"
          shape="round"
          onClick={() => navigate("/")}
          aria-label={t("reader.back")}
          title={t("reader.back")}
        >
          <CaretLeft />
        </Button>
        <PageTitle>
          {seriesName} · {t("manga.volumeCount", { count: volumes.length })}
        </PageTitle>
        <PageActions>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t("manga.seriesMenu.aria")}
                  title={t("manga.seriesMenu.aria")}
                />
              }
            >
              <DotsThree weight="bold" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setRenamingSeries(true)}>
                <PencilSimple />
                {t("manga.seriesMenu.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setMovingSeries(true);
                  setMoveTarget(otherSeries[0] ?? NEW_SERIES);
                  setMoveNewName("");
                }}
              >
                <FolderPlus />
                {t("manga.seriesMenu.move")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeletingSeries(true)}
              >
                <Trash />
                {t("manga.seriesMenu.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" onClick={() => fileRef.current?.click()}>
            <Plus />
            {t("manga.addVolume")}
          </Button>
        </PageActions>
      </PageHeader>
      <PageContent>
        {error ? (
          <p className="mb-6 text-sm text-muted-content">{error}</p>
        ) : null}
        {notice ? (
          <p className="mb-6 text-sm text-muted-content">{notice}</p>
        ) : null}
        <div className="grid grid-cols-3 gap-x-4 gap-y-8 sm:grid-cols-4 lg:grid-cols-5">
          {volumes.map((volume, index) => (
            <div
              key={volume.id}
              draggable
              onDragStart={() => {
                dragIndexRef.current = index;
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDropIndex(index);
              }}
              onDragLeave={() => {
                setDropIndex((current) => (current === index ? null : current));
              }}
              onDrop={(event) => onDropTile(event, index)}
              className={
                dropIndex === index && dragIndexRef.current !== index
                  ? "rounded-media ring-2 ring-ring/50"
                  : ""
              }
            >
              <BookTile
                book={volume}
                subtitle={
                  volume.volumeIndex !== undefined
                    ? t("manga.volume", { index: volume.volumeIndex })
                    : undefined
                }
                menuExtra={
                  <ContextMenuItem
                    onClick={() => {
                      setMovingId(volume.id);
                      setMoveTarget(otherSeries[0] ?? NEW_SERIES);
                      setMoveNewName("");
                    }}
                  >
                    <FolderPlus />
                    {t("manga.moveToSeries")}
                  </ContextMenuItem>
                }
                onOpen={() => onOpenBook(volume.id)}
                onRename={() => setRenamingId(volume.id)}
                onDelete={() => setDeletingId(volume.id)}
              />
            </div>
          ))}
        </div>
      </PageContent>
      {renamingId ? (
        <RenameDialog
          open
          initialTitle={volumes.find((v) => v.id === renamingId)?.title ?? ""}
          onSave={(title) => {
            onRenameBook(renamingId, title);
            setRenamingId(null);
          }}
          onClose={() => setRenamingId(null)}
        />
      ) : null}
      {renamingSeries ? (
        <RenameDialog
          open
          initialTitle={seriesName}
          onSave={(next) => {
            onRenameSeries(seriesName, next);
            setRenamingSeries(false);
          }}
          onClose={() => setRenamingSeries(false)}
        />
      ) : null}
      {movingId ? (
        <Dialog
          open
          onOpenChange={(next) => !next && setMovingId(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("manga.move.title")}</DialogTitle>
            </DialogHeader>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const target =
                  moveTarget === NEW_SERIES ? moveNewName.trim() : moveTarget;
                if (target === "") return;
                onMoveVolume(movingId, target);
                setMovingId(null);
              }}
            >
              <Select
                items={[
                  ...otherSeries.map((name) => ({ value: name, label: name })),
                  { value: NEW_SERIES, label: t("manga.move.newSeries") },
                ]}
                value={moveTarget}
                onValueChange={(value) => {
                  if (value) setMoveTarget(value);
                }}
              >
                <SelectTrigger aria-label={t("manga.move.title")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {otherSeries.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_SERIES}>
                    {t("manga.move.newSeries")}
                  </SelectItem>
                </SelectContent>
              </Select>
              {moveTarget === NEW_SERIES ? (
                <Input
                  autoFocus
                  placeholder={t("manga.move.newSeriesPlaceholder")}
                  value={moveNewName}
                  onChange={(event) => setMoveNewName(event.target.value)}
                />
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setMovingId(null)}
                >
                  {t("library.delete.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={moveTarget === NEW_SERIES && moveNewName.trim() === ""}
                >
                  {t("manga.move.confirm")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
      {deletingId ? (
        <AlertDialog
          open
          onOpenChange={(next) => !next && setDeletingId(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("library.delete.title")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("library.delete.body", {
                  title: volumes.find((v) => v.id === deletingId)?.title ?? "",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("library.delete.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  onDeleteBook(deletingId);
                  setDeletingId(null);
                }}
              >
                {t("library.delete.confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {movingSeries ? (
        <Dialog
          open
          onOpenChange={(next) => !next && setMovingSeries(false)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("manga.moveSeries.title")}</DialogTitle>
            </DialogHeader>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const target =
                  moveTarget === NEW_SERIES ? moveNewName.trim() : moveTarget;
                if (target === "" || target === seriesName) return;
                onMoveSeries(seriesName, target);
                setMovingSeries(false);
              }}
            >
              <Select
                items={[
                  ...otherSeries.map((name) => ({ value: name, label: name })),
                  { value: NEW_SERIES, label: t("manga.move.newSeries") },
                ]}
                value={moveTarget}
                onValueChange={(value) => {
                  if (value) setMoveTarget(value);
                }}
              >
                <SelectTrigger aria-label={t("manga.moveSeries.title")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {otherSeries.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_SERIES}>
                    {t("manga.move.newSeries")}
                  </SelectItem>
                </SelectContent>
              </Select>
              {moveTarget === NEW_SERIES ? (
                <Input
                  autoFocus
                  placeholder={t("manga.move.newSeriesPlaceholder")}
                  value={moveNewName}
                  onChange={(event) => setMoveNewName(event.target.value)}
                />
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setMovingSeries(false)}
                >
                  {t("library.delete.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={moveTarget === NEW_SERIES && moveNewName.trim() === ""}
                >
                  {t("manga.move.confirm")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
      {deletingSeries ? (
        <AlertDialog
          open
          onOpenChange={(next) => !next && setDeletingSeries(false)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("library.delete.title")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("manga.deleteSeries.body", { title: seriesName })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("library.delete.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  onDeleteSeries(seriesName);
                  setDeletingSeries(false);
                }}
              >
                {t("library.delete.confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept=".zip,.cbz,.mokuro,image/*"
        multiple
        hidden
        onChange={onFileChange}
      />
    </PageShell>
  );
}
