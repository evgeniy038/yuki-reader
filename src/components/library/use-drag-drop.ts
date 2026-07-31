import { useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";

// File drag & drop over the whole app shell. The depth counter tracks nested
// enter/leave pairs so the overlay doesn't flicker when crossing child
// boundaries; the first dropped file goes to the importer.
export function useFileDrop(onFile: (file: File) => void) {
  const [dragging, setDragging] = useState(false);
  const depthRef = useRef(0);
  const onFileRef = useRef(onFile);
  onFileRef.current = onFile;

  const handlers = useMemo(
    () => ({
      onDragEnter(event: DragEvent<HTMLDivElement>) {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        depthRef.current += 1;
        setDragging(true);
      },
      onDragOver(event: DragEvent<HTMLDivElement>) {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
      },
      onDragLeave() {
        depthRef.current -= 1;
        if (depthRef.current <= 0) {
          depthRef.current = 0;
          setDragging(false);
        }
      },
      onDrop(event: DragEvent<HTMLDivElement>) {
        event.preventDefault();
        depthRef.current = 0;
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) onFileRef.current(file);
      },
    }),
    [],
  );

  return { dragging, handlers };
}
