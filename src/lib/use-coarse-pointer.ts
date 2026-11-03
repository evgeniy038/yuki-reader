import { useEffect, useState } from "react";

const QUERY = "(pointer: coarse)";

// True when the primary pointer is a finger (phones, tablets without a
// trackpad). For the few decisions CSS can't make: whether a long press is
// a menu or a native drag, whether the reader shows touch chrome.
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== "undefined" && window.matchMedia(QUERY).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const onChange = () => setCoarse(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return coarse;
}
