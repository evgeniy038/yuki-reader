import { useState } from "react";
import type { MokuroBlock } from "@/core/mokuro";

// OCR overlay for one manga page: the text boxes from the sidecar, laid over
// the scan in SOURCE-IMAGE pixel coordinates — the inner layer is natural-size
// and the whole layer scales with the displayed page, so boxes stay glued to
// their bubbles at any zoom. Text is invisible until hovered (the page stays
// readable); a click pins a box open (and stops the page-turn click), which
// also makes its lines selectable. Smaller boxes stack above larger ones
// (z by descending area) so inner bubbles win over their containers.
export function MangaOcrOverlay({
  blocks,
  width,
  height,
  scale,
}: {
  blocks: MokuroBlock[];
  /** Natural image size the box coordinates refer to. */
  width: number;
  height: number;
  /** Displayed-pixels per source-pixel. */
  scale: number;
}) {
  const [pinned, setPinned] = useState<number | null>(null);
  // Biggest first in the DOM, so stacking order = ascending area.
  const order = blocks
    .map((block, index) => ({ block, index }))
    .sort(
      (a, b) =>
        area(b.block.box) - area(a.block.box) || a.index - b.index,
    );
  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
        }}
      >
        {order.map(({ block, index }, stack) => {
          const [x1, y1, x2, y2] = block.box;
          const open = pinned === index;
          return (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
            <div
              key={index}
              data-ocr-block=""
              className="group/ocr absolute cursor-text overflow-hidden"
              style={{
                left: x1,
                top: y1,
                width: Math.max(1, x2 - x1),
                height: Math.max(1, y2 - y1),
                zIndex: 10 + stack,
                fontSize: block.font_size,
                lineHeight: 1.1,
                writingMode: block.vertical ? "vertical-rl" : undefined,
              }}
              onClick={(event) => {
                event.stopPropagation();
                setPinned((current) => (current === index ? null : index));
              }}
            >
              <div
                className={`size-full transition-opacity duration-100 ${
                  open
                    ? "bg-white/95 text-black opacity-100"
                    : "text-transparent opacity-0 group-hover/ocr:bg-white/95 group-hover/ocr:text-black group-hover/ocr:opacity-100"
                }`}
              >
                {block.lines.map((line, lineIndex) => (
                  <p key={lineIndex} className="m-0">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function area(box: [number, number, number, number]): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}
