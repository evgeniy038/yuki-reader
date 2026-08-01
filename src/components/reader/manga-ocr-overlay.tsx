import { useState } from "react";
import type { MokuroBlock } from "@/core/mokuro";
import { fontSizeFor } from "@/core/ocr/font-size";
import { OcrBlockBox } from "./ocr-block-box";

// OCR overlay for one manga page: the text boxes from the sidecar, laid over
// the scan in SOURCE-IMAGE pixel coordinates — the inner layer is natural-size
// and the whole layer scales with the displayed page, so boxes stay glued to
// their bubbles at any zoom. Text is invisible until hovered (the page stays
// readable); a click pins a box open (and stops the page-turn click), which
// also makes its lines selectable. Smaller boxes stack above larger ones
// (z by descending area) so inner bubbles win over their containers.
//
// Hover is JS state, not CSS :hover: only the topmost box under the cursor
// opens, and a box can never stick open — the state dies with the overlay on
// every page turn. Leave clears only its own box, so crossing between
// overlapping boxes can't clobber the fresh hover.
//
// Lazy OCR: a block with empty lines is a detect-only skeleton — hovering it
// fires onRevealBlock so the worker recognizes just this crop, and the box
// shows an ellipsis until the text lands (the reader swaps the blocks in).
export function MangaOcrOverlay({
  blocks,
  width,
  height,
  scale,
  reestimateFontSize = false,
  onRevealBlock,
}: {
  blocks: MokuroBlock[];
  /** Natural image size the box coordinates refer to. */
  width: number;
  height: number;
  /** Displayed-pixels per source-pixel. */
  scale: number;
  /** In-app OCR blocks only: recompute the font estimate at render time, so
      boxes cached by older engines pick up the current estimator. Sidecar
      blocks keep their exact font size. */
  reestimateFontSize?: boolean;
  /** Hover on a not-yet-recognized skeleton block. */
  onRevealBlock?: (blockIndex: number) => void;
}) {
  const [pinned, setPinned] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
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
          const fontSize = reestimateFontSize
            ? fontSizeFor(x2 - x1, y2 - y1, block.lines.join("").length)
            : block.font_size;
          return (
            <OcrBlockBox
              key={index}
              block={block}
              index={index}
              zIndex={10 + stack}
              fontSize={fontSize}
              open={pinned === index || hovered === index}
              onEnter={(i) => {
                setHovered(i);
                if (block.lines.length === 0) onRevealBlock?.(i);
              }}
              onLeave={(i) =>
                setHovered((current) => (current === i ? null : current))
              }
              onToggle={(i) => {
                if (block.lines.length === 0) onRevealBlock?.(i);
                setPinned((current) => (current === i ? null : i));
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function area(box: [number, number, number, number]): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}
