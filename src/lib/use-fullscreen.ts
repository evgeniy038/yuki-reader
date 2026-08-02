import { useEffect, useState } from "react";

// Tracks document fullscreen state. The reader chrome needs it because the
// top strip of a fullscreen screen belongs to the system (macOS menu bar),
// so floating controls park lower there.
export function useFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(
    () => typeof document !== "undefined" && !!document.fullscreenElement,
  );
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);
  return fullscreen;
}
