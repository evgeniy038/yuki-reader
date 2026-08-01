import { useLayoutEffect, useRef, useState } from "react";

// Renders the block's lines at the estimated font size, then shrinks the font
// until the text fits the box — never grows: the OCR font size is only an
// estimate and slightly-smaller-than-original reads fine, bigger does not.
// Measures in layout pixels, so the page-level transform scale does not
// disturb it; all passes run in a layout effect, before paint.
const MAX_PASSES = 8;

export function FitText({
  fontSize,
  lines,
  className,
}: {
  /** Estimated font size (source-image pixels) — the shrink ceiling. */
  fontSize: number;
  lines: string[];
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fitted, setFitted] = useState(fontSize);
  const text = lines.join("\n");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let size = fontSize;
    el.style.fontSize = `${size}px`;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const fit = Math.min(
        1,
        el.clientWidth / Math.max(1, el.scrollWidth),
        el.clientHeight / Math.max(1, el.scrollHeight),
      );
      if (fit > 0.98) break;
      size = Math.max(4, size * fit);
      el.style.fontSize = `${size}px`;
    }
    setFitted(size);
  }, [fontSize, text]);

  return (
    <div ref={ref} className={className} style={{ fontSize: fitted }}>
      {lines.map((line, index) => (
        <p key={index} className="m-0">
          {line}
        </p>
      ))}
    </div>
  );
}
