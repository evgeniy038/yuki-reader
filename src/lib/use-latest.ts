import { useRef } from "react";

// Always-fresh ref for a callback or value used inside an effect/listener:
// the effect keeps its stable deps, the handler still sees the latest render's
// closure. Assigning during render is intentional (React docs-endorsed pattern
// for this exact case).
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
