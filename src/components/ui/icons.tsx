import { useId, type SVGProps } from "react";

// yuki's own icon set — one family in two weights, drawn for a 16-unit grid
// and rendered at 16px (`icon-nav`), so every edge lands on the pixel grid.
// At rest an icon is an OUTLINE; `filled` switches it to the solid body —
// only for what is active right now (the current tab, an open panel, a
// pinned book, a finished task). The rules every glyph follows:
// - live area 1…15 (1px padding), optical weight balanced by eye;
// - outline: 1.5px round strokes; the body is drawn on a slightly smaller
//   grid (×0.9 about the center) so the stroke's outer edge sits on the
//   same 1px padding the solid body fills;
// - solid: filled bodies, corner radius 1–1.75; details knocked out with a
//   1.5px cut (a mask), never drawn in a second color;
// - line glyphs (plus, carets, arrows) are round strokes in both weights —
//   1.5px at rest, 2px when filled;
// - one color: currentColor. Hover and disabled come from the text color of
//   the parent, never from a second asset.
// Export names mirror the Phosphor names they replaced.

type Glyph = {
  // filled body, evenodd
  fill?: string;
  // round stroke
  line?: string;
  // 1.5px knockout through fill and line (solid weight)
  cut?: string;
  // Outline weight, when it can't be derived (the default strokes `fill`
  // and `cut` and keeps `line`): `solid` stays filled (dots), `stroke` is
  // the outlined body and its details.
  outline?: { solid?: string; stroke?: string; line?: string };
};

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  /** The solid weight — for an active state only. */
  filled?: boolean;
};

// Outline bodies shrink 0.9 about the center; the stroke compensates so it
// still renders 1.5 units wide.
const OUTLINE_SCALE = 0.9;
const OUTLINE_STROKE = 1.5;

function Icon({ glyph, filled = false, ...props }: { glyph: Glyph } & IconProps) {
  const maskId = useId();
  const svgProps = {
    viewBox: "0 0 16 16",
    width: "1em",
    height: "1em",
    fill: "currentColor",
    "aria-hidden": true,
    focusable: "false" as const,
    ...props,
  };
  if (!filled) {
    const o = glyph.outline ?? {
      stroke: [glyph.fill, glyph.cut].filter(Boolean).join(""),
      line: glyph.line,
    };
    const body = o.solid || o.stroke;
    const scaled = body ? (
      <g transform={`translate(8 8) scale(${OUTLINE_SCALE}) translate(-8 -8)`}>
        {o.solid ? <path d={o.solid} fillRule="evenodd" /> : null}
        {o.stroke ? (
          <path
            d={o.stroke}
            fill="none"
            stroke="currentColor"
            strokeWidth={OUTLINE_STROKE / OUTLINE_SCALE}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {o.line ? (
          <path
            d={o.line}
            fill="none"
            stroke="currentColor"
            strokeWidth={OUTLINE_STROKE / OUTLINE_SCALE}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </g>
    ) : o.line ? (
      // Line glyphs keep their full size.
      <path
        d={o.line}
        fill="none"
        stroke="currentColor"
        strokeWidth={OUTLINE_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ) : null;
    return <svg {...svgProps}>{scaled}</svg>;
  }
  return (
    <svg {...svgProps}>
      {glyph.cut ? (
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <rect width="16" height="16" fill="white" />
          <path
            d={glyph.cut}
            fill="none"
            stroke="black"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </mask>
      ) : null}
      <g mask={glyph.cut ? `url(#${maskId})` : undefined}>
        {glyph.fill ? <path d={glyph.fill} fillRule="evenodd" /> : null}
        {glyph.line ? (
          <path
            d={glyph.line}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </g>
    </svg>
  );
}

function glyph(name: string, g: Glyph) {
  const Component = (props: IconProps) => <Icon glyph={g} {...props} />;
  Component.displayName = name;
  return Component;
}

const ring = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

// ── Reading

export const Books = glyph("Books", {
  fill:
    "M2 3.5H3.25A1 1 0 0 1 4.25 4.5V13.5A1 1 0 0 1 3.25 14.5H2A1 1 0 0 1 1 13.5V4.5A1 1 0 0 1 2 3.5Z" +
    "M6.25 1.5H7.5A1 1 0 0 1 8.5 2.5V13.5A1 1 0 0 1 7.5 14.5H6.25A1 1 0 0 1 5.25 13.5V2.5A1 1 0 0 1 6.25 1.5Z" +
    "M9.791 3.582A1 1 0 0 1 10.582 2.409L11.661 2.199A1 1 0 0 1 12.834 2.99L14.742 12.806A1 1 0 0 1 13.951 13.979L12.871 14.189A1 1 0 0 1 11.699 13.398Z",
  cut: "M0 11.5H9M10.336 11.625L15.342 10.652",
  outline: {
    stroke:
      "M2 3.5H3.25A1 1 0 0 1 4.25 4.5V13.5A1 1 0 0 1 3.25 14.5H2A1 1 0 0 1 1 13.5V4.5A1 1 0 0 1 2 3.5Z" +
      "M6.25 1.5H7.5A1 1 0 0 1 8.5 2.5V13.5A1 1 0 0 1 7.5 14.5H6.25A1 1 0 0 1 5.25 13.5V2.5A1 1 0 0 1 6.25 1.5Z" +
      "M9.791 3.582A1 1 0 0 1 10.582 2.409L11.661 2.199A1 1 0 0 1 12.834 2.99L14.742 12.806A1 1 0 0 1 13.951 13.979L12.871 14.189A1 1 0 0 1 11.699 13.398Z",
    line: "M1 11.5H4.25M5.25 11.5H8.5M11.25 11.5L14.3 10.9",
  },
});

export const Book = glyph("Book", {
  fill: "M4.25 1H11.75A1.75 1.75 0 0 1 13.5 2.75V13.25A1.75 1.75 0 0 1 11.75 15H4.25A1.75 1.75 0 0 1 2.5 13.25V2.75A1.75 1.75 0 0 1 4.25 1Z",
  cut: "M5.25 0V16",
  outline: {
    stroke:
      "M4.25 1H11.75A1.75 1.75 0 0 1 13.5 2.75V13.25A1.75 1.75 0 0 1 11.75 15H4.25A1.75 1.75 0 0 1 2.5 13.25V2.75A1.75 1.75 0 0 1 4.25 1Z" +
      "M5.25 1V15",
  },
});

export const BookOpen = glyph("BookOpen", {
  fill:
    "M1 3.75A1 1 0 0 1 2.05 2.75C4.2 2.85 5.95 3.35 7.25 4.25V14C5.95 13.15 4.2 12.7 2.05 12.6A1 1 0 0 1 1 11.6Z" +
    "M15 3.75A1 1 0 0 0 13.95 2.75C11.8 2.85 10.05 3.35 8.75 4.25V14C10.05 13.15 11.8 12.7 13.95 12.6A1 1 0 0 0 15 11.6Z",
});

export const Bookmark = glyph("Bookmark", {
  fill: "M3.5 3.25A1.75 1.75 0 0 1 5.25 1.5H10.75A1.75 1.75 0 0 1 12.5 3.25V13.295A0.6 0.6 0 0 1 11.538 13.773L8.241 11.282A0.4 0.4 0 0 0 7.759 11.282L4.462 13.773A0.6 0.6 0 0 1 3.5 13.295Z",
});

export const Star = glyph("Star", {
  fill: "M7.084 2.945A1 1 0 0 1 8.916 2.945L10.022 5.473A0.4 0.4 0 0 0 10.349 5.711L13.096 5.981A1 1 0 0 1 13.662 7.724L11.599 9.557A0.4 0.4 0 0 0 11.474 9.941L12.065 12.637A1 1 0 0 1 10.583 13.714L8.202 12.319A0.4 0.4 0 0 0 7.798 12.319L5.417 13.714A1 1 0 0 1 3.935 12.637L4.526 9.941A0.4 0.4 0 0 0 4.401 9.557L2.338 7.724A1 1 0 0 1 2.904 5.981L5.651 5.711A0.4 0.4 0 0 0 5.978 5.473Z",
});

export const ChartLine = glyph("ChartLine", {
  fill:
    "M2.5 8.5H4A1 1 0 0 1 5 9.5V13.5A1 1 0 0 1 4 14.5H2.5A1 1 0 0 1 1.5 13.5V9.5A1 1 0 0 1 2.5 8.5Z" +
    "M7.25 4.75H8.75A1 1 0 0 1 9.75 5.75V13.5A1 1 0 0 1 8.75 14.5H7.25A1 1 0 0 1 6.25 13.5V5.75A1 1 0 0 1 7.25 4.75Z" +
    "M12 1.5H13.5A1 1 0 0 1 14.5 2.5V13.5A1 1 0 0 1 13.5 14.5H12A1 1 0 0 1 11 13.5V2.5A1 1 0 0 1 12 1.5Z",
});

export const List = glyph("List", {
  fill: ring(2.75, 4, 1.25) + ring(2.75, 8, 1.25) + ring(2.75, 12, 1.25),
  line: "M6.5 4H13.5M6.5 8H13.5M6.5 12H13.5",
  outline: {
    solid: ring(2.75, 4, 1.25) + ring(2.75, 8, 1.25) + ring(2.75, 12, 1.25),
    line: "M6.5 4H13.5M6.5 8H13.5M6.5 12H13.5",
  },
});

export const MagnifyingGlass = glyph("MagnifyingGlass", {
  line: "M11.75 7A4.75 4.75 0 1 1 2.25 7A4.75 4.75 0 1 1 11.75 7ZM10.5 10.5L14 14",
});

export const CornersOut = glyph("CornersOut", {
  line: "M2 5.5V3A1 1 0 0 1 3 2H5.5M10.5 2H13A1 1 0 0 1 14 3V5.5M14 10.5V13A1 1 0 0 1 13 14H10.5M5.5 14H3A1 1 0 0 1 2 13V10.5",
});

// ── Objects and actions

export const Gear = glyph("Gear", {
  fill: "M13.25 8.363A0.426 0.426 0 0 0 13.497 8.87L14.392 9.24A0.6 0.6 0 0 1 14.717 10.024L14.181 11.318A0.6 0.6 0 0 1 13.397 11.643L12.502 11.272A0.426 0.426 0 0 0 11.969 11.455L11.865 11.639A0.6 0.6 0 0 1 11.639 11.865L11.455 11.969A0.426 0.426 0 0 0 11.272 12.502L11.643 13.397A0.6 0.6 0 0 1 11.318 14.181L10.024 14.717A0.6 0.6 0 0 1 9.24 14.392L8.87 13.497A0.426 0.426 0 0 0 8.363 13.25L8.16 13.306A0.6 0.6 0 0 1 7.84 13.306L7.637 13.25A0.426 0.426 0 0 0 7.13 13.497L6.76 14.392A0.6 0.6 0 0 1 5.976 14.717L4.682 14.181A0.6 0.6 0 0 1 4.357 13.397L4.728 12.502A0.426 0.426 0 0 0 4.545 11.969L4.361 11.865A0.6 0.6 0 0 1 4.135 11.639L4.031 11.455A0.426 0.426 0 0 0 3.498 11.272L2.603 11.643A0.6 0.6 0 0 1 1.819 11.318L1.283 10.024A0.6 0.6 0 0 1 1.608 9.24L2.503 8.87A0.426 0.426 0 0 0 2.75 8.363L2.694 8.16A0.6 0.6 0 0 1 2.694 7.84L2.75 7.637A0.426 0.426 0 0 0 2.503 7.13L1.608 6.76A0.6 0.6 0 0 1 1.283 5.976L1.819 4.682A0.6 0.6 0 0 1 2.603 4.357L3.498 4.728A0.426 0.426 0 0 0 4.031 4.545L4.135 4.361A0.6 0.6 0 0 1 4.361 4.135L4.545 4.031A0.426 0.426 0 0 0 4.728 3.498L4.357 2.603A0.6 0.6 0 0 1 4.682 1.819L5.976 1.283A0.6 0.6 0 0 1 6.76 1.608L7.13 2.503A0.426 0.426 0 0 0 7.637 2.75L7.84 2.694A0.6 0.6 0 0 1 8.16 2.694L8.363 2.75A0.426 0.426 0 0 0 8.87 2.503L9.24 1.608A0.6 0.6 0 0 1 10.024 1.283L11.318 1.819A0.6 0.6 0 0 1 11.643 2.603L11.272 3.498A0.426 0.426 0 0 0 11.455 4.031L11.639 4.135A0.6 0.6 0 0 1 11.865 4.361L11.969 4.545A0.426 0.426 0 0 0 12.502 4.728L13.397 4.357A0.6 0.6 0 0 1 14.181 4.682L14.717 5.976A0.6 0.6 0 0 1 14.392 6.76L13.497 7.13A0.426 0.426 0 0 0 13.25 7.637L13.306 7.84A0.6 0.6 0 0 1 13.306 8.16Z" +
    ring(8, 8, 2.2),
});

export const Trash = glyph("Trash", {
  fill:
    "M2.875 3H13.125A0.875 0.875 0 0 1 13.125 4.75H2.875A0.875 0.875 0 0 1 2.875 3Z" +
    "M6 3V2.25A1 1 0 0 1 7 1.25H9A1 1 0 0 1 10 2.25V3Z" +
    "M3.298 6.544A0.5 0.5 0 0 1 3.796 6H12.204A0.5 0.5 0 0 1 12.702 6.544L12.121 13.132A1.5 1.5 0 0 1 10.627 14.5H5.373A1.5 1.5 0 0 1 3.879 13.132Z",
  cut: "M6.5 8.25V12M9.5 8.25V12",
  outline: {
    stroke:
      "M3.298 6.544A0.5 0.5 0 0 1 3.796 6H12.204A0.5 0.5 0 0 1 12.702 6.544L12.121 13.132A1.5 1.5 0 0 1 10.627 14.5H5.373A1.5 1.5 0 0 1 3.879 13.132Z" +
      "M6.5 8.25V12M9.5 8.25V12",
    line: "M2.5 3.875H13.5M6 3.875V2.25A1 1 0 0 1 7 1.25H9A1 1 0 0 1 10 2.25V3.875",
  },
});

export const PencilSimple = glyph("PencilSimple", {
  fill:
    "M3.007 13.444A0.35 0.35 0 0 1 2.556 12.993L3.886 9.464A0.3 0.3 0 0 1 3.955 9.358L9.566 3.747A0.6 0.6 0 0 1 10.415 3.747L12.253 5.585A0.6 0.6 0 0 1 12.253 6.434L6.642 12.045A0.3 0.3 0 0 1 6.536 12.114Z" +
    "M11.122 2.616A0.3 0.3 0 0 1 11.122 2.191L11.298 2.015A0.55 0.55 0 0 1 12.076 2.015L13.985 3.924A0.55 0.55 0 0 1 13.985 4.702L13.809 4.878A0.3 0.3 0 0 1 13.384 4.878Z",
});

export const Image = glyph("Image", {
  fill: "M2.75 2.5H13.25A1.75 1.75 0 0 1 15 4.25V11.75A1.75 1.75 0 0 1 13.25 13.5H2.75A1.75 1.75 0 0 1 1 11.75V4.25A1.75 1.75 0 0 1 2.75 2.5Z",
  cut: "M1 12.5L5 8.5L8.5 12L10.5 10L14.5 14M10.5 5.75A0.5 0.5 0 1 0 11.5 5.75A0.5 0.5 0 1 0 10.5 5.75Z",
  outline: {
    stroke:
      "M2.75 2.5H13.25A1.75 1.75 0 0 1 15 4.25V11.75A1.75 1.75 0 0 1 13.25 13.5H2.75A1.75 1.75 0 0 1 1 11.75V4.25A1.75 1.75 0 0 1 2.75 2.5Z" +
      ring(11, 5.75, 1),
    line: "M1 12L5 8.25L8.25 11.5L10.25 9.5L13.75 13",
  },
});

export const FileArrowUp = glyph("FileArrowUp", {
  fill: "M2.5 2.5A1.5 1.5 0 0 1 4 1H8.586A1 1 0 0 1 9.293 1.293L13.207 5.207A1 1 0 0 1 13.5 5.914V13.5A1.5 1.5 0 0 1 12 15H4A1.5 1.5 0 0 1 2.5 13.5Z",
  cut: "M8 12V7.5M5.75 9.5L8 7.25L10.25 9.5",
});

export const FolderPlus = glyph("FolderPlus", {
  fill: "M1 3.75A1.25 1.25 0 0 1 2.25 2.5H5.689A0.75 0.75 0 0 1 6.22 2.72L7.28 3.78A0.75 0.75 0 0 0 7.811 4H13.75A1.25 1.25 0 0 1 15 5.25V12.25A1.25 1.25 0 0 1 13.75 13.5H2.25A1.25 1.25 0 0 1 1 12.25Z",
  cut: "M8 6.5V11.5M5.5 9H10.5",
});

export const DownloadSimple = glyph("DownloadSimple", {
  line: "M8 2V10.25M4.5 6.75L8 10.25L11.5 6.75M2.5 13.75H13.5",
});

export const UploadSimple = glyph("UploadSimple", {
  line: "M8 10.25V2M4.5 5.5L8 2L11.5 5.5M2.5 13.75H13.5",
});

export const DotsThree = glyph("DotsThree", {
  fill: ring(3, 8, 1.5) + ring(8, 8, 1.5) + ring(13, 8, 1.5),
  outline: { solid: ring(3, 8, 1.5) + ring(8, 8, 1.5) + ring(13, 8, 1.5) },
});

export const DotsSixVertical = glyph("DotsSixVertical", {
  fill:
    ring(5.75, 3.5, 1.25) + ring(10.25, 3.5, 1.25) +
    ring(5.75, 8, 1.25) + ring(10.25, 8, 1.25) +
    ring(5.75, 12.5, 1.25) + ring(10.25, 12.5, 1.25),
  outline: {
    solid:
      ring(5.75, 3.5, 1.25) + ring(10.25, 3.5, 1.25) +
      ring(5.75, 8, 1.25) + ring(10.25, 8, 1.25) +
      ring(5.75, 12.5, 1.25) + ring(10.25, 12.5, 1.25),
  },
});

// ── Status

export const Info = glyph("Info", {
  fill: ring(8, 8, 7),
  cut: "M8 7.25V11.25M8 4.75H8.01",
});

export const CheckCircle = glyph("CheckCircle", {
  fill: ring(8, 8, 7),
  cut: "M5 8.25L7 10.25L11 6.25",
});

export const Check = glyph("Check", { line: "M3 8.5L6.25 11.75L13 5" });

// ── Sync

const cloud =
  "M4.5 13.5A3.25 3.25 0 0 1 4.061 7.03A4.25 4.25 0 0 1 12.49 8.044A2.75 2.75 0 0 1 12 13.5Z";

export const CloudArrowUp = glyph("CloudArrowUp", {
  fill: cloud,
  cut: "M8 12V8.25M6.25 10L8 8.25L9.75 10",
});

export const CloudArrowDown = glyph("CloudArrowDown", {
  fill: cloud,
  cut: "M8 8.25V12M6.25 10.25L8 12L9.75 10.25",
});

export const CloudCheck = glyph("CloudCheck", {
  fill: cloud,
  cut: "M5.75 10.5L7.25 12L10.25 9",
});

export const CloudSlash = glyph("CloudSlash", {
  fill: cloud,
  line: "M2.25 2.25L13.75 13.75",
  cut: "M3.5 1L15 12.5",
  outline: { stroke: cloud, line: "M2.25 2.25L13.75 13.75" },
});

export const ArrowsClockwise = glyph("ArrowsClockwise", {
  line: "M13.5 8A5.5 5.5 0 1 1 11.89 4.11M9.25 4.25H12.25V1.25",
});

export const Copy = glyph("Copy", {
  fill: "M6.75 5H13.25A1.75 1.75 0 0 1 15 6.75V13.25A1.75 1.75 0 0 1 13.25 15H6.75A1.75 1.75 0 0 1 5 13.25V6.75A1.75 1.75 0 0 1 6.75 5Z",
  line: "M2 10V3.5A1.5 1.5 0 0 1 3.5 2H10",
});

export const Key = glyph("Key", {
  fill: ring(5, 8, 4) + ring(5, 8, 1.5),
  line: "M8.5 8H14M11.75 8V10.5M14 8V10",
});

// ── Line marks

export const Plus = glyph("Plus", { line: "M8 2.75V13.25M2.75 8H13.25" });

export const Minus = glyph("Minus", { line: "M2.75 8H13.25" });

export const X = glyph("X", { line: "M4 4L12 12M12 4L4 12" });

export const CaretDown = glyph("CaretDown", { line: "M3.5 5.75L8 10.25L12.5 5.75" });

export const CaretUp = glyph("CaretUp", { line: "M3.5 10.25L8 5.75L12.5 10.25" });

export const CaretLeft = glyph("CaretLeft", { line: "M10.25 3.5L5.75 8L10.25 12.5" });

export const CaretRight = glyph("CaretRight", { line: "M5.75 3.5L10.25 8L5.75 12.5" });
