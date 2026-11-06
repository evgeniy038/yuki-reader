// A tiny interruptible spring for gesture-driven motion (manga pager, pinch
// release). Apple's two designer parameters instead of mass/stiffness:
// `damping` (1 = critically damped, no overshoot; < 1 bounces) and
// `response` (seconds to reach the target — not a duration, the settle time
// emerges). It always starts from the value it is given and carries the
// gesture's release velocity, so a flick hands off with no seam, and a new
// touch can stop it mid-flight and grab the live value.

export interface SpringOptions {
  damping?: number;
  response?: number;
  /** px/s at the start — the finger's release velocity. */
  velocity?: number;
  /** How close counts as arrived, in the animated value's own units. */
  precision?: number;
}

/** One integration step (unit mass), exported for the unit test. */
export function springStep(
  x: number,
  v: number,
  target: number,
  dt: number,
  damping: number,
  response: number,
): { x: number; v: number } {
  const stiffness = (2 * Math.PI / response) ** 2;
  const friction = (4 * Math.PI * damping) / response;
  const accel = -stiffness * (x - target) - friction * v;
  const nextV = v + accel * dt;
  return { x: x + nextV * dt, v: nextV };
}

/** Settled when within `precision` (half a pixel) and nearly still. */
export function springSettled(x: number, v: number, target: number, precision = 0.5): boolean {
  return Math.abs(x - target) < precision && Math.abs(v) < precision * 16;
}

export interface SpringHandle {
  /** Stop where it is (the caller reads the live value it was fed). */
  stop: () => void;
}

const reduceMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Animate `from` → `to`, calling `onFrame` with each value (rAF-synced).
    Reduced motion jumps straight to the target. */
export function animateSpring(
  from: number,
  to: number,
  onFrame: (value: number) => void,
  { damping = 1, response = 0.32, velocity = 0, precision = 0.5 }: SpringOptions = {},
  onDone?: () => void,
): SpringHandle {
  if (reduceMotion()) {
    onFrame(to);
    onDone?.();
    return { stop: () => {} };
  }
  let x = from;
  let v = velocity;
  let last = performance.now();
  let raf = 0;
  let stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    // Clamp long frames (a background tab) and sub-step for stability.
    let dt = Math.min(0.064, Math.max(0, (now - last) / 1000));
    last = now;
    while (dt > 0) {
      const step = Math.min(dt, 1 / 240);
      ({ x, v } = springStep(x, v, to, step, damping, response));
      dt -= step;
    }
    if (springSettled(x, v, to, precision)) {
      onFrame(to);
      onDone?.();
      return;
    }
    onFrame(x);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
    },
  };
}

/** A spring on a 0→1 progress, for callers that map it onto many values.
    Pixel thresholds mean nothing on this scale. */
export function animateProgress(
  onFrame: (progress: number) => void,
  options: Pick<SpringOptions, "damping" | "response"> = {},
  onDone?: () => void,
): SpringHandle {
  return animateSpring(0, 1, onFrame, { ...options, precision: 0.0005 }, onDone);
}

/** Glide a 0→1 progress to rest the way a scroll does: full speed at once,
    then only ever slowing, with no spring in it. `seconds` is the decay's
    time constant, so a value travelling D leaves at D / seconds per second —
    pick D = speed × seconds and the motion continues the finger seamlessly.
    It ends once less than `precision` of the way is left. */
export function animateGlide(
  seconds: number,
  precision: number,
  onFrame: (progress: number) => void,
): SpringHandle {
  if (reduceMotion()) {
    onFrame(1);
    return { stop: () => {} };
  }
  const start = performance.now();
  let raf = 0;
  let stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    const left = Math.exp(-Math.max(0, now - start) / 1000 / seconds);
    if (left < precision) {
      onFrame(1);
      return;
    }
    onFrame(1 - left);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
    },
  };
}

/** Where a flick would come to rest (Apple's scroll-deceleration
    projection): px/s in, px of travel out. */
export function projectMomentum(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Progressive resistance past an edge: the further, the less it follows. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (
    (overshoot * dimension * constant) /
    (dimension + constant * Math.abs(overshoot))
  );
}
