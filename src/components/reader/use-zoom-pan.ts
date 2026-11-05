import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent, RefObject } from "react";
import { animateSpring, projectMomentum, type SpringHandle } from "@/lib/spring";

// Zoom + pan for the manga stage. The transform lives in a ref and is
// written straight to the page layer — a pinch or a wheel burst repaints
// one style, never re-renders the page set (OCR overlay included). React
// state only learns whether the page is zoomed at all (cursor, gestures).
//   Mouse: the wheel zooms toward the cursor in both directions — the point
// under it never moves, so no sideways drift and no re-centering on
// zoom-out. A drag pans whenever zoom ≠ 1. No bounds, no snap to center;
// the user owns the page position.
//   Touch (driven by useMangaTouch through `setTransform`/`settle`): pinch
// around the fingers, pan inside the page's bounds, and on release the
// page springs back inside them — never smaller than fitted.
// Page turns call `reset`.
const MAX_ZOOM = 5;
const MIN_ZOOM = 1 / 3;
// Wheel delta → zoom factor: exp(-deltaY * SPEED). 0.01 ≈ a full 1→5 zoom
// range in ~160px of wheel travel — punchy but still controllable.
const ZOOM_SPEED = 0.01;
// Don't steal clicks after a pan: swallow the click that ends a real drag.
const PAN_THRESHOLD_PX = 4;

export interface ZoomPan {
  zoom: number;
  x: number;
  y: number;
}

export const IDENTITY: ZoomPan = { zoom: 1, x: 0, y: 0 };
export const TOUCH_MAX_ZOOM = 4;

/** Clamp a pan so the scaled layer always covers the stage where it can
    (and stays centered along an axis where it is smaller than the stage). */
export function clampPan(
  t: ZoomPan,
  layer: { width: number; height: number },
  stage: { width: number; height: number },
): ZoomPan {
  const maxX = Math.max(0, (layer.width * t.zoom - stage.width) / 2);
  const maxY = Math.max(0, (layer.height * t.zoom - stage.height) / 2);
  // No travel on an axis = exactly centered (never a stray -0).
  const clamp = (value: number, max: number) =>
    max === 0 ? 0 : Math.min(max, Math.max(-max, value));
  return { zoom: t.zoom, x: clamp(t.x, maxX), y: clamp(t.y, maxY) };
}

/** Zoomed pans decelerate like scrolling. */
const PAN_DECELERATION = 0.995;

/** Where a released pan, flung at (vx, vy) px/s, comes to rest — inside the
    page bounds. */
export function flingPan(
  t: ZoomPan,
  vx: number,
  vy: number,
  layer: { width: number; height: number },
  stage: { width: number; height: number },
): ZoomPan {
  return clampPan(
    {
      zoom: t.zoom,
      x: t.x + projectMomentum(vx, PAN_DECELERATION),
      y: t.y + projectMomentum(vy, PAN_DECELERATION),
    },
    layer,
    stage,
  );
}

export function useZoomPan({
  targetRef,
  layerRef,
  enabled,
}: {
  /** The stage: wheel and mouse pans land here. */
  targetRef: RefObject<HTMLDivElement | null>;
  /** The page layer the transform is written to. */
  layerRef: RefObject<HTMLDivElement | null>;
  /** Input is live only when the book is ready. */
  enabled: boolean;
}) {
  const transformRef = useRef<ZoomPan>(IDENTITY);
  const [zoomed, setZoomed] = useState(false);
  const springRef = useRef<SpringHandle | null>(null);
  const dragRef = useRef<{ px: number; py: number; moved: boolean } | null>(
    null,
  );
  const suppressClickRef = useRef(false);

  /** Paint the stored transform onto the current layer node. */
  const paint = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const t = transformRef.current;
    layer.style.transform =
      t.zoom === 1 && t.x === 0 && t.y === 0
        ? ""
        : `translate(${t.x}px, ${t.y}px) scale(${t.zoom})`;
  }, [layerRef]);

  /** Write a transform to the layer (and the zoomed flag on a crossing). */
  const setTransform = useCallback(
    (next: ZoomPan) => {
      transformRef.current = next;
      paint();
      setZoomed(Math.abs(next.zoom - 1) > 0.001);
    },
    [paint],
  );

  const stop = useCallback(() => {
    springRef.current?.stop();
    springRef.current = null;
  }, []);

  /** Spring from the live transform to `to`. */
  const animateTo = useCallback(
    (to: ZoomPan) => {
      stop();
      const from = transformRef.current;
      springRef.current = animateSpring(
        0,
        1,
        (k) =>
          setTransform({
            zoom: from.zoom + (to.zoom - from.zoom) * k,
            x: from.x + (to.x - from.x) * k,
            y: from.y + (to.y - from.y) * k,
          }),
        { damping: 1, response: 0.3 },
      );
    },
    [setTransform, stop],
  );

  /** Touch release: back inside [1, TOUCH_MAX_ZOOM] and inside the bounds. */
  const settle = useCallback(() => {
    const layer = layerRef.current;
    const stage = targetRef.current;
    if (!layer || !stage) return;
    const t = transformRef.current;
    const zoom = Math.min(TOUCH_MAX_ZOOM, Math.max(1, t.zoom));
    // Re-anchor a clamped zoom on the stage center so the pan scales with it.
    const k = zoom / t.zoom;
    const target =
      zoom <= 1
        ? IDENTITY
        : clampPan(
            { zoom, x: t.x * k, y: t.y * k },
            { width: layer.offsetWidth, height: layer.offsetHeight },
            { width: stage.clientWidth, height: stage.clientHeight },
          );
    if (target.zoom !== t.zoom || target.x !== t.x || target.y !== t.y)
      animateTo(target);
  }, [animateTo, layerRef, targetRef]);

  const reset = useCallback(() => {
    stop();
    setTransform(IDENTITY);
  }, [setTransform, stop]);

  // The layer node changes with the visible set: carry the transform over
  // before paint (a turn resets it to identity first anyway).
  useLayoutEffect(paint);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || !enabled) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      stop();
      const rect = target.getBoundingClientRect();
      const px = event.clientX - (rect.left + rect.width / 2);
      const py = event.clientY - (rect.top + rect.height / 2);
      const current = transformRef.current;
      const factor = Math.exp(-event.deltaY * ZOOM_SPEED);
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor));
      // Both directions: the point under the cursor stays stationary.
      const k = next / current.zoom;
      setTransform({
        zoom: next,
        x: px - (px - current.x) * k,
        y: py - (py - current.y) * k,
      });
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => target.removeEventListener("wheel", onWheel);
  }, [targetRef, enabled, setTransform, stop]);

  useEffect(() => stop, [stop]);

  const endDrag = () => {
    if (dragRef.current?.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    dragRef.current = null;
  };

  // Mouse pan only — fingers belong to useMangaTouch.
  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "mouse") return;
      if (transformRef.current.zoom === 1 || event.button !== 0) return;
      // Don't hijack OCR box interactions.
      if ((event.target as HTMLElement).closest("[data-ocr-block]")) return;
      stop();
      dragRef.current = { px: event.clientX, py: event.clientY, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.px;
      const dy = event.clientY - drag.py;
      if (!drag.moved && Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return;
      drag.moved = true;
      drag.px = event.clientX;
      drag.py = event.clientY;
      const current = transformRef.current;
      setTransform({ ...current, x: current.x + dx, y: current.y + dy });
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current) {
        event.stopPropagation();
        event.preventDefault();
      }
    },
  };

  return {
    transformRef,
    zoomed,
    setTransform,
    animateTo,
    settle,
    stop,
    reset,
    handlers,
  };
}
