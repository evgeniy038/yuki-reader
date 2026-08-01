import type { MokuroBlock } from "@/core/mokuro";
import { FitText } from "./fit-text";

// One OCR text box, absolutely positioned over the scan in source-image
// coordinates. Open/closed comes from the overlay as plain props — JS hover
// (mouseenter/leave on the topmost box under the cursor) instead of CSS
// :hover, which kept overlapping containers open together with their inner
// bubbles and could leave a box stuck open. Text is invisible at rest and
// selectable only while open; a skeleton (detect-only) box shows an ellipsis
// until recognition lands.
export function OcrBlockBox({
  block,
  index,
  zIndex,
  fontSize,
  open,
  onEnter,
  onLeave,
  onToggle,
}: {
  block: MokuroBlock;
  index: number;
  zIndex: number;
  /** Display font size: the block's own (sidecar-exact) or re-estimated. */
  fontSize: number;
  open: boolean;
  onEnter: (index: number) => void;
  onLeave: (index: number) => void;
  onToggle: (index: number) => void;
}) {
  const [x1, y1, x2, y2] = block.box;
  const skeleton = block.lines.length === 0;
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      data-ocr-block=""
      className="absolute cursor-text overflow-hidden"
      style={{
        left: x1,
        top: y1,
        width: Math.max(1, x2 - x1),
        height: Math.max(1, y2 - y1),
        zIndex,
        fontSize,
        lineHeight: 1.2,
        writingMode: block.vertical ? "vertical-rl" : undefined,
      }}
      onMouseEnter={() => onEnter(index)}
      onMouseLeave={() => onLeave(index)}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(index);
      }}
    >
      <div
        className={`size-full transition-opacity duration-100 ${
          open
            ? "select-text bg-white/95 text-black opacity-100"
            : "select-none text-transparent opacity-0"
        }`}
      >
        {skeleton ? (
          <span className="flex size-full items-center justify-center text-black/50">
            …
          </span>
        ) : (
          <FitText
            fontSize={fontSize}
            lines={block.lines}
            className="size-full"
          />
        )}
      </div>
    </div>
  );
}
