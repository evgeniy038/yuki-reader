import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Rename dialog: one prefilled input, Enter saves, Esc / backdrop cancels.
export function RenameDialog({
  initialTitle,
  open,
  onSave,
  onClose,
}: {
  initialTitle: string;
  open: boolean;
  onSave: (title: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (open) {
      setValue(initialTitle);
      // The popup mounts async — focus after it lands.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, initialTitle]);

  const save = () => {
    const title = value.trim();
    if (title !== "") onSave(title);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("library.rename.title")}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Input
            ref={inputRef}
            aria-label={t("library.rename.aria")}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("library.delete.cancel")}
            </Button>
            <Button type="submit">{t("library.rename.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
