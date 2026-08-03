import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useLatest } from "@/lib/use-latest";

// Trackpad bursts must not machine-gun page turns.
const WHEEL_GUARD_MS = 220;
// Click-to-turn zones: a slim strip at each screen edge — wide enough to hit
// deliberately, narrow enough that selecting text or clicking the page never
// flips it by accident.
const EDGE_CLICK_PX = 50;
// Less pointer movement than this between down and click is a click; more is
// a drag (text selection, pan) whose trailing synthetic click must not page.
const DRAG_THRESHOLD_PX = 5;

// Paged-turn input, shared by all readers: wheel (guarded), optional
// click-to-turn and paging keys. Click paging uses live page bounds when
// provided (`clickBoundsRef`, manga), otherwise slim edge strips (PDF).
// A click that ends a drag or starts on an existing selection never pages —
// tracked from pointerdown, because browsers can collapse a drag selection
// before the click handler runs.
// `vertical` (Japanese books) flips the horizontal wheel sign, mirrors the
// click zones and swaps the arrow keys; the PDF reader is horizontal-only,
// so it passes false.
export function usePagingInput({
  targetRef,
  vertical,
  enabled,
  wheel = true,
  click = true,
  keyboard = "all",
  clickBoundsRef,
  edgeClickPx = EDGE_CLICK_PX,
  ignoreClickSelector,
  onStep,
}: {
  /** Element that owns wheel/click (the scroll box or the stage). */
  targetRef: RefObject<HTMLElement | null>;
  vertical: boolean;
  /** Input is live only when the book is ready (PDF: document loaded). */
  enabled: boolean;
  /** Wheel paging — off where the wheel has another job (manga zoom). */
  wheel?: boolean;
  /** Mouse click paging — off where clicks should only select text. */
  click?: boolean;
  /** Keyboard paging keys — all legacy keys or arrow keys only. */
  keyboard?: "all" | "arrows";
  /**
   * Visible page bounds. When present, clicks outside these bounds turn the
   * page instead of the fixed edge strips.
   */
  clickBoundsRef?: RefObject<HTMLElement | null>;
  /** Width of the edge-click strips (edges mode only). */
  edgeClickPx?: number;
  /** Clicks landing inside this selector never page. */
  ignoreClickSelector?: string;
  onStep: (dir: 1 | -1) => void;
}) {
  const lastWheelRef = useRef(0);
  const verticalRef = useLatest(vertical);
  const wheelRef = useLatest(wheel);
  const keyboardRef = useLatest(keyboard);
  const edgeClickPxRef = useLatest(edgeClickPx);
  const ignoreClickSelectorRef = useLatest(ignoreClickSelector);
  const onStepRef = useLatest(onStep);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || !enabled) return;

    const onWheel = (event: WheelEvent) => {
      if (!wheelRef.current) return;
      // The side panels and the page indicator handle their own scrolling —
      // a wheel gesture inside them must not page the book behind them.
      const el = event.target as Element | null;
      if (el?.closest("[data-reader-panel], [data-page-indicator]")) return;
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
    // The browser can collapse a drag selection before the click fires, so
    // remember at pointerdown whether this interaction is a drag or started
    // on top of a selection.
    let sawDown = false;
    let downX = 0;
    let downY = 0;
    let downHadSelection = false;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      sawDown = true;
      downX = event.clientX;
      downY = event.clientY;
      downHadSelection = !!window.getSelection()?.toString().trim();
    };
    const onClick = (event: MouseEvent) => {
      const dragClick =
        sawDown &&
        (downHadSelection ||
          Math.hypot(event.clientX - downX, event.clientY - downY) >
            DRAG_THRESHOLD_PX);
      sawDown = false;
      if (dragClick) return;
      if (window.getSelection()?.toString().trim()) return;
      const el = event.target as Element | null;
      if (
        el?.closest(
          "[data-page-indicator], a, button, input, textarea, select, summary, [role='button'], [contenteditable='true']",
        )
      )
        return;
      if (el?.closest("[data-dictionary-popup]")) return;
      const ignoreSel = ignoreClickSelectorRef.current;
      if (ignoreSel && el?.closest(ignoreSel)) return;

      // Prefer the live page bounds; clicks in the margins around them turn
      // the page. Vertical/RTL reads forward on the left, back on the right;
      // horizontal reads the mirror.
      const boundsEl = clickBoundsRef?.current;
      if (boundsEl) {
        const bounds = boundsEl.getBoundingClientRect();
        const leftOf = event.clientX < bounds.left;
        const rightOf = event.clientX > bounds.right;
        const forward = verticalRef.current ? leftOf : rightOf;
        const back = verticalRef.current ? rightOf : leftOf;
        if (forward) onStepRef.current(1);
        else if (back) onStepRef.current(-1);
        return;
      }

      const rect = target.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const px = edgeClickPxRef.current;
      const forward = verticalRef.current ? x < px : x > rect.width - px;
      const back = verticalRef.current ? x > rect.width - px : x < px;
      if (forward) onStepRef.current(1);
      else if (back) onStepRef.current(-1);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.shiftKey) return;
      const isArrow =
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown";
      if (keyboardRef.current === "arrows" && !isArrow) return;
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
    if (click) {
      target.addEventListener("pointerdown", onPointerDown);
      target.addEventListener("click", onClick);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      target.removeEventListener("wheel", onWheel);
      if (click) {
        target.removeEventListener("pointerdown", onPointerDown);
        target.removeEventListener("click", onClick);
      }
      window.removeEventListener("keydown", onKey);
    };
  }, [targetRef, enabled, click, verticalRef, onStepRef]);
}
