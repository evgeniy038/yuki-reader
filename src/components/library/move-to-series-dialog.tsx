import { useState } from "react";
import { useTranslation } from "react-i18next";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NEW_SERIES = "__new__";

// Move-to-series picker: existing series or a fresh name. Used for a single
// volume and for a whole series; `excludeTarget` bars a no-op target (a
// series cannot move into itself). The target/new-name state lives here: the
// dialog mounts fresh on every open.
export function MoveToSeriesDialog({
  open,
  title,
  otherSeries,
  excludeTarget,
  onMove,
  onClose,
}: {
  open: boolean;
  /** Dialog title, also the select's aria-label. */
  title: string;
  /** Every other series on the shelf, display order. */
  otherSeries: string[];
  /** A target that makes the move a no-op (the moving series itself). */
  excludeTarget?: string;
  onMove: (target: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [moveTarget, setMoveTarget] = useState<string>(
    otherSeries[0] ?? NEW_SERIES,
  );
  const [moveNewName, setMoveNewName] = useState("");

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const target =
              moveTarget === NEW_SERIES ? moveNewName.trim() : moveTarget;
            if (target === "" || target === excludeTarget) return;
            onMove(target);
            onClose();
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
            <SelectTrigger aria-label={title}>
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
            <Button type="button" variant="secondary" onClick={onClose}>
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
  );
}
