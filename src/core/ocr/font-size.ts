// Font-size estimate for an OCR block, shared by the pipeline (storage) and
// the reader overlay (render-time re-estimate for blocks cached by older
// engines). Kept in a dependency-free module so the UI never pulls the OCR
// runtime in.

/**
 * The text is modeled as ink filling the box — `chars` squares of font size —
 * so size ≈ sqrt(coverage × area / chars). Coverage 0.30 is calibrated
 * against .mokuro ground truth (exact font sizes) matched to OUR detector
 * boxes: their boxes are tight, ours carry slack, and manga columns break by
 * phrase (uneven fill), so the true coverage sits well below the naive 1.
 * The constant errs small on purpose (median ratio ≈ 0.8, ~21% mild
 * overshoot) — bigger-than-original is the failure to avoid; the overlay's
 * shrink-to-fit trims the rest. Without text (detect-only skeleton) fall back
 * to ~6 chars per line.
 */
export function fontSizeFor(
  width: number,
  height: number,
  chars: number,
): number {
  const estimate =
    chars > 0
      ? Math.sqrt((0.3 * width * height) / chars)
      : Math.max(width, height) / 6;
  return Math.min(64, Math.max(8, Math.round(estimate)));
}
