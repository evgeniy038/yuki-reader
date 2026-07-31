import { useLayoutEffect, useRef, useState } from "react";

// Geometry for a sliding indicator (iOS-style morph): measures the active
// child's box inside its container so a single absolutely-positioned
// indicator can move there with a transform-only animation (composited, no
// layout). The child is found by [data-indicator-target="<activeKey>"].
// pos is null until the first measure, so the indicator mounts already in
// place — no slide-in on first paint.
export function useSlidingIndicator<T extends HTMLElement>(activeKey: string) {
  const containerRef = useRef<T>(null);
  const [pos, setPos] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const target = el.querySelector<HTMLElement>(
        `[data-indicator-target="${activeKey}"]`,
      );
      if (!target) return;
      const next = { x: target.offsetLeft, w: target.offsetWidth };
      setPos((prev) =>
        prev && prev.x === next.x && prev.w === next.w ? prev : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeKey]);

  return { containerRef, pos };
}
