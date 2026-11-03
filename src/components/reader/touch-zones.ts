// Touch reading geometry, shared by every reader and pinned by a unit test.
// A phone screen splits into three vertical bands, like Apple Books and
// Kindle: the outer bands turn the page, the middle one shows the controls.
// Japanese books (vertical text, manga) read right-to-left, so their
// FORWARD band is on the left and a swipe to the right turns forward —
// the finger pulls the next page in from the left, as in a printed book.

/** Share of the width each outer band takes; the middle gets the rest. */
export const SIDE_BAND = 0.3;
/** Finger travel under this is still a tap, not a drag. */
export const TAP_SLOP_PX = 10;
/** A press longer than this is a long press (text selection), not a tap. */
export const TAP_MAX_MS = 450;
/** A swipe commits past this distance… */
export const SWIPE_COMMIT_PX = 48;
/** …or faster than this release velocity (px/ms), whatever the distance. */
export const SWIPE_COMMIT_VELOCITY = 0.35;

export type TapZone = "back" | "menu" | "forward";

export function tapZone(x: number, width: number, rtl: boolean): TapZone {
  const share = width > 0 ? x / width : 0.5;
  if (share < SIDE_BAND) return rtl ? "forward" : "back";
  if (share > 1 - SIDE_BAND) return rtl ? "back" : "forward";
  return "menu";
}

/** Page direction of a horizontal swipe: 1 forward, -1 back, 0 stay.
    `dx` is total finger travel, `vx` the release velocity (px/ms). A flick
    against the travel (a hesitation) cancels. */
export function swipeStep(dx: number, vx: number, rtl: boolean): 1 | -1 | 0 {
  const fast = Math.abs(vx) >= SWIPE_COMMIT_VELOCITY;
  const far = Math.abs(dx) >= SWIPE_COMMIT_PX;
  if (!fast && !far) return 0;
  // A fast release decides by its own sign; a slow one by the distance.
  const sign = fast ? Math.sign(vx) : Math.sign(dx);
  if (fast && far && Math.sign(dx) !== sign) return 0;
  if (sign === 0) return 0;
  // LTR: finger moves left (dx < 0) → forward. RTL: right → forward.
  const forward = rtl ? sign > 0 : sign < 0;
  return forward ? 1 : -1;
}

/** Release velocity (px/ms) from the last ~100ms of pointer samples. */
export function releaseVelocity(
  samples: readonly { x: number; t: number }[],
  windowMs = 100,
): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    const sample = samples[i]!;
    if (last.t - sample.t > windowMs) break;
    first = sample;
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/** Elements a touch on the reading surface must leave alone. */
export const TOUCH_IGNORE_SELECTOR =
  "[data-page-indicator], [data-reader-panel], [data-dictionary-popup], [data-ocr-block], a, button, input, textarea, select, summary, [role='button'], [role='slider'], [contenteditable='true']";
