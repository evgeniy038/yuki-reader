import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useLatest } from "@/lib/use-latest";

// Trackpad bursts must not machine-gun page turns.
const WHEEL_GUARD_MS = 220;
// Click-to-turn zones: a slim strip at each screen edge — wide enough to hit
// deliberately, narrow enough that selecting text or clicking the page never
// flips it by accident.
const EDGE_CLICK_PX = 50;

// Paged-turn input, shared by both readers: wheel (guarded), edge clicks
// (50px strips) and paging keys. `vertical` (Japanese books)
// flips the horizontal wheel sign,
// mirrors the click zones and swaps the arrow keys; the PDF reader is
// horizontal-only, so it passes false.
export function usePagingInput({
  targetRef,
  vertical,
  enabled,
  wheel = true,
  onStep,
}: {
  /** Element that owns wheel/click (the scroll box or the stage). */
  targetRef: RefObject<HTMLElement | null>;
  vertical: boolean;
  /** Input is live only when the book is ready (PDF: document loaded). */
  enabled: boolean;
  /** Wheel paging — off where the wheel has another job (manga zoom). */
  wheel?: boolean;
  onStep: (dir: 1 | -1) => void;
}) {
  const lastWheelRef = useRef(0);
  const verticalRef = useLatest(vertical);
  const wheelRef = useLatest(wheel);
  const onStepRef = useLatest(onStep);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || !enabled) return;

    const onWheel = (event: WheelEvent) => {
      if (!wheelRef.current) return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastWheelRef.current < WHEEL_GUARD_MS) return;
      // Reference mapping: the horizontal wheel component flips sign in
      // vertical mode.
      let d = 0;
      if (event.deltaX !== 0)
        d = (event.deltaX < 0 ? -1 : 1) * (verticalRef.current ? -1 : 1);
      else if (event.deltaY !== 0) d = event.deltaY < 0 ? -1 : 1;
      if (d === 0) return;
      lastWheelRef.current = now;
      onStepRef.current(d > 0 ? 1 : -1);
    };
    const onClick = (event: MouseEvent) => {
      if (window.getSelection()?.toString().trim()) return;
      const rect = target.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const forward = verticalRef.current
        ? x < EDGE_CLICK_PX
        : x > rect.width - EDGE_CLICK_PX;
      const back = verticalRef.current
        ? x > rect.width - EDGE_CLICK_PX
        : x < EDGE_CLICK_PX;
      if (forward) onStepRef.current(1);
      else if (back) onStepRef.current(-1);
    };
    const onKey = (event: KeyboardEvent) => {
      const v = verticalRef.current;
      const fwd = v
        ? event.key === "ArrowLeft" ||
          event.key === "PageDown" ||
          event.key === " " ||
          event.key === "Spacebar"
        : event.key === "ArrowRight" ||
          event.key === "ArrowDown" ||
          event.key === "PageDown" ||
          event.key === " " ||
          event.key === "Spacebar";
      const bwd = v
        ? event.key === "ArrowRight" ||
          event.key === "ArrowUp" ||
          event.key === "PageUp"
        : event.key === "ArrowLeft" ||
          event.key === "ArrowUp" ||
          event.key === "PageUp";
      if (!fwd && !bwd) return;
      event.preventDefault();
      onStepRef.current(fwd ? 1 : -1);
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    target.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      target.removeEventListener("wheel", onWheel);
      target.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [targetRef, enabled, verticalRef, onStepRef]);
}
