import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent, RefObject } from "react";

// Zoom + pan for the manga stage: the wheel zooms toward the cursor in both
// directions — the point under it never moves, so no sideways drift and no
// re-centering on zoom-out (the page simply keeps whatever offset the anchor
// math leaves). A drag pans whenever zoom ≠ 1 (zoomed in or out). No
// bounds, no snap to center; the user owns the page position, page turns
// call `reset`. The wheel listener is native (passive: false) so the page
// never scrolls.
const MAX_ZOOM = 5;
const MIN_ZOOM = 1 / 3;
// Wheel delta → zoom factor: exp(-deltaY * SPEED). 0.01 ≈ a full 1→5 zoom
// range in ~160px of wheel travel — punchy but still controllable.
const ZOOM_SPEED = 0.01;
// Don't steal clicks after a pan: swallow the click that ends a real drag.
const PAN_THRESHOLD_PX = 4;

export function useZoomPan({
  targetRef,
  enabled,
}: {
  targetRef: RefObject<HTMLDivElement | null>;
  /** Input is live only when the book is ready. */
  enabled: boolean;
}) {
  const [zoomPan, setZoomPan] = useState({ zoom: 1, x: 0, y: 0 });
  const dragRef = useRef<{ px: number; py: number; moved: boolean } | null>(
    null,
  );
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || !enabled) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      const px = event.clientX - (rect.left + rect.width / 2);
      const py = event.clientY - (rect.top + rect.height / 2);
      setZoomPan((current) => {
        const factor = Math.exp(-event.deltaY * ZOOM_SPEED);
        const next = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, current.zoom * factor),
        );
        // Both directions: the point under the cursor stays stationary.
        const k = next / current.zoom;
        return {
          zoom: next,
          x: px - (px - current.x) * k,
          y: py - (py - current.y) * k,
        };
      });
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => target.removeEventListener("wheel", onWheel);
  }, [targetRef, enabled]);

  const endDrag = () => {
    if (dragRef.current?.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    dragRef.current = null;
  };

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (zoomPan.zoom === 1 || event.button !== 0) return;
      // Don't hijack OCR box interactions.
      if ((event.target as HTMLElement).closest("[data-ocr-block]")) return;
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
      setZoomPan((current) => ({
        ...current,
        x: current.x + dx,
        y: current.y + dy,
      }));
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
    zoomPan,
    zoomed: zoomPan.zoom !== 1,
    reset: () => setZoomPan({ zoom: 1, x: 0, y: 0 }),
    handlers,
  };
}
