import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useLatest } from "@/lib/use-latest";
import { animateSpring, rubberband, type SpringHandle } from "@/lib/spring";
import {
  TAP_MAX_MS,
  TAP_SLOP_PX,
  TOUCH_IGNORE_SELECTOR,
  pagerTurn,
  tapZone,
  velocityOf,
  type Sample,
} from "./touch-zones";
import { clampPan, flingPan, IDENTITY, type ZoomPan, type useZoomPan } from "./use-zoom-pan";

// Finger reading for manga — the pager and the loupe in one recognizer,
// because they share every touch and must hand off mid-gesture:
//   one finger, fitted page → the PAGER: the neighbouring spread is already
//     on the track beside this one (right-to-left: the next page waits on
//     the LEFT), the track follows the finger 1:1, and on release the
//     momentum-projected landing decides turn or stay; the turn commits at
//     once and the slide finishes on a spring carrying the finger's speed.
//     Past the book's edge the track resists (rubber band).
//   one finger, zoomed page → PAN, rubber-banded at the page bounds, flung
//     with momentum, settled back inside on release.
//   two fingers → PINCH around their midpoint (two-finger pan included);
//     lifting one hands over to pan without a jump.
//   tap → outer bands turn (left = forward), the middle band shows the
//     controls; a double tap in the middle zooms to that spot or back out.
//     Only the middle band waits for a possible second tap — page-turn taps
//     fire at once. A tap first closes an open OCR box; a tap ON a box is
//     the box's own (it opens).
// Every animation starts from the live value and can be grabbed mid-flight.
// With the page-turn animation off (a reading setting) the pager doesn't
// slide or follow the finger — a tap or a swipe just flips the set.

const DOUBLE_TAP_MS = 260;
const DOUBLE_TAP_SLOP_PX = 30;
const DOUBLE_TAP_ZOOM = 2.5;

type ZoomApi = Pick<
  ReturnType<typeof useZoomPan>,
  "transformRef" | "setTransform" | "settle" | "animateTo" | "stop" | "reset"
>;

export function useMangaTouch({
  stageRef,
  trackRef,
  layerRef,
  enabled,
  animate = true,
  zoom,
  canTurn,
  neighborReady,
  onTurn,
  onMenu,
  onDismissOcr,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  /** The pager track (current set at 0, neighbours one stage-width aside). */
  trackRef: RefObject<HTMLDivElement | null>;
  /** The current set's zoom layer. */
  layerRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  /** The page-turn animation setting: false = turns just flip. */
  animate?: boolean;
  zoom: ZoomApi;
  /** A neighbouring set exists in that direction. */
  canTurn: (dir: 1 | -1) => boolean;
  /** …and its pages are already resolved (safe to slide in). */
  neighborReady: (dir: 1 | -1) => boolean;
  /** Commit the turn (page state); the view calls `afterTurn` on render. */
  onTurn: (dir: 1 | -1) => void;
  onMenu: () => void;
  /** Close an open OCR box; true if one was open. */
  onDismissOcr: () => boolean;
}) {
  const zoomRef = useLatest(zoom);
  const animateRef = useLatest(animate);
  const canTurnRef = useLatest(canTurn);
  const neighborReadyRef = useLatest(neighborReady);
  const onTurnRef = useLatest(onTurn);
  const onMenuRef = useLatest(onMenu);
  const onDismissOcrRef = useLatest(onDismissOcr);
  const trackXRef = useRef(0);
  const trackSpringRef = useRef<SpringHandle | null>(null);
  // A committed turn waiting for its render: shift the track by this much
  // and spring home with the finger's velocity.
  const pendingRef = useRef<{ shift: number; velocity: number } | null>(null);

  const paintTrack = (x: number) => {
    trackXRef.current = x;
    const track = trackRef.current;
    if (track) track.style.transform = x ? `translateX(${x}px)` : "";
  };

  const springTrack = (velocity: number) => {
    trackSpringRef.current?.stop();
    trackSpringRef.current = animateSpring(
      trackXRef.current,
      0,
      paintTrack,
      { damping: 1, response: 0.34, velocity },
      () => {
        trackSpringRef.current = null;
      },
    );
  };

  /** Turn one set; `velocity` px/s of an animated slide, null = no slide. */
  const turn = (dir: 1 | -1, velocity: number | null): boolean => {
    if (!canTurnRef.current(dir)) return false;
    const width = stageRef.current?.clientWidth ?? 0;
    // Forward (right-to-left) pulls the next page in from the left: the
    // new current page starts one stage to the left and slides home.
    pendingRef.current =
      animateRef.current && velocity !== null && width > 0 && neighborReadyRef.current(dir)
        ? { shift: dir > 0 ? -width : width, velocity }
        : null;
    zoomRef.current.reset();
    onTurnRef.current(dir);
    return true;
  };

  /** The view calls this in a layout effect after every page change. */
  const afterTurn = () => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    trackSpringRef.current?.stop();
    trackSpringRef.current = null;
    if (!pending) {
      paintTrack(0);
      return;
    }
    paintTrack(trackXRef.current + pending.shift);
    springTrack(pending.velocity);
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !enabled) return;

    const pointers = new Map<number, { x: number; y: number }>();
    type Mode = "idle" | "pending" | "page" | "pan" | "pinch" | "vertical";
    let mode: Mode = "idle";
    let start = { x: 0, y: 0, t: 0 };
    let startTrack = 0;
    let startT: ZoomPan = IDENTITY;
    let pinch0 = { d: 1, mx: 0, my: 0 };
    let samples: Sample[] = [];
    let tapTimer = 0;
    let lastTap: { x: number; y: number; t: number } | null = null;

    const center = () => {
      const rect = stage.getBoundingClientRect();
      return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
    };
    const sizes = () => ({
      layer: {
        width: layerRef.current?.offsetWidth ?? 0,
        height: layerRef.current?.offsetHeight ?? 0,
      },
      stage: { width: stage.clientWidth, height: stage.clientHeight },
    });
    const zoomed = () => Math.abs(zoomRef.current.transformRef.current.zoom - 1) > 0.01;

    const beginPinch = () => {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const { cx, cy } = center();
      mode = "pinch";
      pinch0 = {
        d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        mx: (a.x + b.x) / 2 - cx,
        my: (a.y + b.y) / 2 - cy,
      };
      startT = zoomRef.current.transformRef.current;
    };
    const beginPan = (x: number, y: number) => {
      mode = "pan";
      start = { x, y, t: performance.now() };
      startT = zoomRef.current.transformRef.current;
      samples = [{ x, y, t: performance.now() }];
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      const el = event.target as Element | null;
      // OCR boxes stay draggable (bubbles cover the page); real controls
      // are left alone entirely.
      if (el?.closest(TOUCH_IGNORE_SELECTOR) && !el.closest("[data-ocr-block]")) return;
      // A first finger means no other is down: drop a lift iOS never sent
      // (an app switch mid-touch — copy an OCR line, check a translation),
      // or every swipe after it reads as a pinch with a ghost finger.
      if (event.isPrimary) forget();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      zoomRef.current.stop();
      if (pointers.size === 2) {
        // A page drag in progress gives way to the pinch.
        if (mode === "page") {
          if (animateRef.current) springTrack(0);
          else paintTrack(0);
        }
        beginPinch();
        return;
      }
      if (pointers.size > 2) return;
      // Grab the track mid-slide: the gesture continues from where it is.
      trackSpringRef.current?.stop();
      trackSpringRef.current = null;
      startTrack = trackXRef.current;
      mode = "pending";
      start = { x: event.clientX, y: event.clientY, t: event.timeStamp };
      startT = zoomRef.current.transformRef.current;
      samples = [{ x: event.clientX, y: event.clientY, t: performance.now() }];
    };

    const onMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (mode === "pinch") {
        const [a, b] = [...pointers.values()];
        if (!a || !b) return;
        const { cx, cy } = center();
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2 - cx;
        const my = (a.y + b.y) / 2 - cy;
        const z = Math.min(6, Math.max(0.6, (startT.zoom * d) / pinch0.d));
        // The content point that was under the fingers stays under them.
        const px = (pinch0.mx - startT.x) / startT.zoom;
        const py = (pinch0.my - startT.y) / startT.zoom;
        zoomRef.current.setTransform({ zoom: z, x: mx - px * z, y: my - py * z });
        return;
      }
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      samples.push({ x: event.clientX, y: event.clientY, t: performance.now() });
      if (samples.length > 12) samples.shift();
      if (mode === "pending") {
        // A grabbed, still-moving track is already a page drag.
        if (startTrack !== 0) mode = "page";
        else if (Math.hypot(dx, dy) <= TAP_SLOP_PX) return;
        else if (zoomed()) beginPan(event.clientX, event.clientY);
        else mode = Math.abs(dx) > Math.abs(dy) ? "page" : "vertical";
      }
      if (mode === "page") {
        const width = stage.clientWidth || 1;
        let x = startTrack + dx;
        // No neighbour that way: resist instead of revealing a void.
        if ((x > 0 && !canTurnRef.current(1)) || (x < 0 && !canTurnRef.current(-1)))
          x = rubberband(x, width);
        if (animateRef.current) paintTrack(x);
        else trackXRef.current = x; // judged on release, never shown
        return;
      }
      if (mode === "pan") {
        const raw = {
          zoom: startT.zoom,
          x: startT.x + (event.clientX - start.x),
          y: startT.y + (event.clientY - start.y),
        };
        const { layer, stage: box } = sizes();
        const bounded = clampPan(raw, layer, box);
        zoomRef.current.setTransform({
          zoom: raw.zoom,
          x: bounded.x + rubberband(raw.x - bounded.x, box.width),
          y: bounded.y + rubberband(raw.y - bounded.y, box.height),
        });
      }
    };

    const tap = (event: PointerEvent) => {
      const el = event.target as Element | null;
      if (el?.closest("[data-ocr-block]")) return;
      if (onDismissOcrRef.current()) return;
      const rect = stage.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const zone = tapZone(x, rect.width, true);
      if (zone !== "menu") {
        window.clearTimeout(tapTimer);
        lastTap = null;
        turn(zone === "forward" ? 1 : -1, 0);
        return;
      }
      const now = performance.now();
      if (
        lastTap &&
        now - lastTap.t < DOUBLE_TAP_MS &&
        Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < DOUBLE_TAP_SLOP_PX
      ) {
        window.clearTimeout(tapTimer);
        lastTap = null;
        const api = zoomRef.current;
        if (zoomed()) {
          api.animateTo(IDENTITY);
          return;
        }
        const { cx, cy } = center();
        const px = event.clientX - cx;
        const py = event.clientY - cy;
        const { layer, stage: box } = sizes();
        api.animateTo(
          clampPan(
            { zoom: DOUBLE_TAP_ZOOM, x: px - px * DOUBLE_TAP_ZOOM, y: py - py * DOUBLE_TAP_ZOOM },
            layer,
            box,
          ),
        );
        return;
      }
      lastTap = { x: event.clientX, y: event.clientY, t: now };
      window.clearTimeout(tapTimer);
      tapTimer = window.setTimeout(() => {
        lastTap = null;
        onMenuRef.current();
      }, DOUBLE_TAP_MS);
    };

    const onUp = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      if (mode === "pinch") {
        // One finger left: it carries on as a pan from right here.
        const rest = [...pointers.values()][0];
        if (rest) beginPan(rest.x, rest.y);
        else {
          mode = "idle";
          zoomRef.current.settle();
        }
        return;
      }
      if (pointers.size > 0) return;
      const gesture = mode;
      mode = "idle";
      if (gesture === "pending") {
        if (event.timeStamp - start.t <= TAP_MAX_MS) tap(event);
        return;
      }
      if (gesture === "page") {
        samples.push({ x: event.clientX, y: event.clientY, t: performance.now() });
        const { vx } = velocityOf(samples);
        const dir = pagerTurn(trackXRef.current, vx, stage.clientWidth || 1);
        if (dir !== 0 && turn(dir, vx)) return;
        if (animateRef.current) springTrack(vx);
        else paintTrack(0);
        return;
      }
      if (gesture === "pan") {
        samples.push({ x: event.clientX, y: event.clientY, t: performance.now() });
        const { vx, vy } = velocityOf(samples);
        const { layer, stage: box } = sizes();
        zoomRef.current.animateTo(flingPan(zoomRef.current.transformRef.current, vx, vy, layer, box));
      }
    };

    const onCancel = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      if (pointers.size > 0) return;
      if (mode === "page") {
        if (animateRef.current) springTrack(0);
        else paintTrack(0);
      }
      if (mode === "pinch" || mode === "pan") zoomRef.current.settle();
      mode = "idle";
    };

    /** Drop every finger and gesture — a fresh start (stale touches, or the
        app going to the background mid-gesture). */
    const forget = () => {
      if (pointers.size === 0 && mode === "idle") return;
      pointers.clear();
      if (mode === "page") paintTrack(0);
      if (mode === "pinch" || mode === "pan") zoomRef.current.settle();
      mode = "idle";
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") forget();
    };

    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onCancel);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("blur", forget);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("blur", forget);
      window.clearTimeout(tapTimer);
      trackSpringRef.current?.stop();
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerup", onUp);
      stage.removeEventListener("pointercancel", onCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageRef, layerRef, enabled]);

  return { afterTurn };
}
