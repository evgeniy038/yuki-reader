import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileArrowUp } from "@/components/ui/icons";
import type { BackupOperationProgress } from "@/core/backup";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HiddenFileInput } from "@/components/ui/hidden-file-input";
import { TransferProgress } from "./transfer-progress";

// The import dialog: a dropzone (file pick or drag-and-drop), replaced in
// place by the live transfer readout once the restore starts.
export function BackupImportDialog({
  open,
  busy,
  progress,
  label,
  detail,
  error,
  onFile,
  onCancelTask,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  progress: BackupOperationProgress | null;
  label: string;
  detail?: string;
  error: string | null;
  /** A chosen file (drop or pick); undefined = an empty pick. */
  onFile: (file: File | undefined) => void;
  onCancelTask: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const chooseFile = (file: File | undefined) => {
    dragDepth.current = 0;
    setDragging(false);
    onFile(file);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md gap-4 p-5">
        <DialogHeader>
          <DialogTitle>{t("settings.backup.importTitle")}</DialogTitle>
          {!busy ? (
            <p className="text-sm text-muted-content">
              {t("settings.backup.importHint")}
            </p>
          ) : null}
        </DialogHeader>
        {busy ? (
          // Same height as the dropzone it replaces.
          <div className="flex min-h-36 flex-col justify-center">
            <TransferProgress
              progress={progress}
              label={label}
              detail={detail}
            />
          </div>
        ) : (
          <>
            <HiddenFileInput
              inputRef={inputRef}
              accept=".zip,.yuki,application/zip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                chooseFile(file);
              }}
            />
            <div
              role="button"
              tabIndex={0}
              aria-label={t("settings.backup.dropzone")}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                dragDepth.current += 1;
                setDragging(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={() => {
                // dragenter/dragleave fire in pairs when the pointer moves
                // across children — only the outermost leave ends the drag.
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                chooseFile(event.dataTransfer.files[0]);
              }}
              className={`flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-5 text-center outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 ${
                dragging
                  ? "border-primary bg-primary/5"
                  : "border-subtle hover:border-strong hover:bg-hover-surface"
              }`}
            >
              <FileArrowUp className="mb-2 size-6 text-muted-content" />
              <p className="text-sm font-medium text-default">
                {dragging
                  ? t("settings.backup.dropActive")
                  : t("settings.backup.dropzone")}
              </p>
              <p className="mt-1 text-xs text-muted-content">
                {t("settings.backup.browse")}
              </p>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </>
        )}
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={busy ? onCancelTask : onClose}
          >
            {t("settings.backup.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
