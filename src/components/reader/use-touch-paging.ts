import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useLatest } from "@/lib/use-latest";
import { animateSpring, rubberband, type SpringHandle } from "@/lib/spring";
import {
  TAP_MAX_MS,
  TAP_SLOP_PX,
  TOUCH_IGNORE_SELECTOR,
  releaseVelocity,
  swipeStep,
  tapZone,
} from "./touch-zones";

// Finger paging for the text and PDF readers (manga has its own pager with
// a live carousel and pinch zoom). Mouse input never reaches here — a
// desktop keeps its wheel, keys and edge clicks untouched.
//   Tap: outer bands turn the page, the middle band toggles the controls.
//   A tap while text is selected only clears the selection.
//   Swipe: the page box follows the finger with growing resistance (there
//   is no neighbour page to reveal in a reflowed book), then the turn
//   lands with a short slide in the same direction; a swipe that falls
//   short springs back.
//   Long press: left to the browser — text selection.

/** How far a committed page slides in from, as a share of the width. */
const ENTER_SHARE = 0.14;
const ENTER_MS = 240;
const ENTER_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

const reduceMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Slide a freshly turned page in from the side it travels from. */
export function playPageEnter(
  el: HTMLElement | null,
  dir: 1 | -1,
  rtl: boolean,
): void {
  if (!el) return;
  el.style.transform = "";
  if (reduceMotion()) {
    el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 160 });
    return;
  }
  // Forward moves content toward the reading start: left in LTR, right in
  // RTL — so the new page comes in from the opposite edge.
  const towardRight = rtl ? dir > 0 : dir < 0;
  const from = (towardRight ? -1 : 1) * ENTER_SHARE * el.offsetWidth;
  el.animate(
    [
      { transform: `translateX(${from}px)`, opacity: 0.35 },
      { transform: "translateX(0)", opacity: 1 },
    ],
    { duration: ENTER_MS, easing: ENTER_EASE },
  );
}

export function useTouchPaging({
  targetRef,
  dragRef,
  enabled,
  rtl,
  enterOnStep = true,
  onStep,
  onMenu,
}: {
  /** The reading surface that receives the touches. */
  targetRef: RefObject<HTMLElement | null>;
  /** The page box that follows the finger and slides on a turn. */
  dragRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  /** Right-to-left reading (vertical Japanese). */
  rtl: boolean;
  /** Slide the page box in right after the turn. Off where the new page
      renders asynchronously (PDF) — that view plays it on arrival. */
  enterOnStep?: boolean;
  /** Turn by one page; false = nothing to turn to (the book's edge). */
  onStep: (dir: 1 | -1) => boolean;
  /** Middle-band tap: show or hide the reader controls. */
  onMenu: () => void;
}) {
  const rtlRef = useLatest(rtl);
  const enterOnStepRef = useLatest(enterOnStep);
  const onStepRef = useLatest(onStep);
  const onMenuRef = useLatest(onMenu);
  const springRef = useRef<SpringHandle | null>(null);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || !enabled) return;

    let active: {
      id: number;
      x0: number;
      y0: number;
      t0: number;
      axis: "x" | "y" | null;
      samples: { x: number; t: number }[];
    } | null = null;
    let shift = 0;

    const setShift = (value: number) => {
      shift = value;
      const el = dragRef.current;
      if (el) el.style.transform = value ? `translateX(${value}px)` : "";
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      // A second finger: this is not a page gesture.
      if (active) {
        active = null;
        setShift(0);
        return;
      }
      const el = event.target as Element | null;
      if (el?.closest(TOUCH_IGNORE_SELECTOR)) return;
      springRef.current?.stop();
      springRef.current = null;
      active = {
        id: event.pointerId,
        x0: event.clientX,
        y0: event.clientY,
        t0: event.timeStamp,
        axis: null,
        samples: [{ x: event.clientX, t: event.timeStamp }],
      };
    };

    const onMove = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.id) return;
      const dx = event.clientX - active.x0;
      const dy = event.clientY - active.y0;
      if (!active.axis && Math.hypot(dx, dy) > TAP_SLOP_PX) {
        active.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (active.axis !== "x") return;
      active.samples.push({ x: event.clientX, t: event.timeStamp });
      if (active.samples.length > 12) active.samples.shift();
      const width = target.clientWidth || 1;
      setShift(rubberband(dx, width / 2));
    };

    const onUp = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.id) return;
      const gesture = active;
      active = null;
      const dx = event.clientX - gesture.x0;
      const width = target.clientWidth || 1;

      if (gesture.axis === "x") {
        gesture.samples.push({ x: event.clientX, t: event.timeStamp });
        const dir = swipeStep(dx, releaseVelocity(gesture.samples), rtlRef.current);
        if (dir !== 0 && onStepRef.current(dir)) {
          setShift(0);
          if (enterOnStepRef.current)
            playPageEnter(dragRef.current, dir, rtlRef.current);
          return;
        }
        springRef.current = animateSpring(shift, 0, setShift, {
          damping: 1,
          response: 0.28,
        });
        return;
      }
      if (gesture.axis === "y") return;
      if (event.timeStamp - gesture.t0 > TAP_MAX_MS) return;

      // A tap. First, it dismisses a selection rather than paging past it.
      const selection = window.getSelection();
      if (selection && selection.toString().trim()) {
        selection.removeAllRanges();
        return;
      }
      const rect = target.getBoundingClientRect();
      const zone = tapZone(event.clientX - rect.left, width, rtlRef.current);
      if (zone === "menu") {
        onMenuRef.current();
        return;
      }
      const dir = zone === "forward" ? 1 : -1;
      if (onStepRef.current(dir) && enterOnStepRef.current)
        playPageEnter(dragRef.current, dir, rtlRef.current);
    };

    const onCancel = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.id) return;
      active = null;
      setShift(0);
    };

    target.addEventListener("pointerdown", onDown);
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onCancel);
    return () => {
      springRef.current?.stop();
      target.removeEventListener("pointerdown", onDown);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onCancel);
    };
  }, [targetRef, dragRef, enabled, rtlRef, enterOnStepRef, onStepRef, onMenuRef]);
}
