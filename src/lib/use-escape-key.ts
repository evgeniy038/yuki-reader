import { useEffect } from "react";
import { useLatest } from "./use-latest";

// Close-on-Escape, the recurring popup/panel rule: a window keydown listener
// for the component's lifetime, handler always fresh.
export function useEscapeKey(onEscape: () => void) {
  const onEscapeRef = useLatest(onEscape);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscapeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscapeRef]);
}
