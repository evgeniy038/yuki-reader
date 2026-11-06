// Node unit test for the touch reading geometry: tap bands, swipe decisions,
// release velocity, the spring and its helpers, manga neighbour sets and the
// zoom pan bounds. Pure functions — no browser needed.
// Run: pnpm tsx tests/reader-touch-unit.ts

import { strict as assert } from "node:assert";
import {
  SWIPE_COMMIT_PX,
  releaseVelocity,
  pagerTurn,
  swipeStep,
  tapZone,
  velocityOf,
} from "../src/components/reader/touch-zones.ts";
import {
  neighborFirst,
  spreadFirstOf,
  visibleNums,
} from "../src/components/reader/spread-paging.ts";
import { clampPan } from "../src/components/reader/use-zoom-pan.ts";
import {
  animateGlide,
  animateProgress,
  projectMomentum,
  rubberband,
  springSettled,
  springStep,
} from "../src/lib/spring.ts";

// --- tap bands ----------------------------------------------------------------
{
  const w = 440;
  // Left-to-right book: left band back, right band forward.
  assert.equal(tapZone(20, w, false), "back");
  assert.equal(tapZone(420, w, false), "forward");
  // Right-to-left (vertical Japanese, manga): mirrored.
  assert.equal(tapZone(20, w, true), "forward");
  assert.equal(tapZone(420, w, true), "back");
  // The middle band is the controls in both.
  assert.equal(tapZone(220, w, false), "menu");
  assert.equal(tapZone(220, w, true), "menu");
  // Band edges: 30% each side.
  assert.equal(tapZone(w * 0.29, w, true), "forward");
  assert.equal(tapZone(w * 0.31, w, true), "menu");
  assert.equal(tapZone(w * 0.71, w, true), "back");
  // A zero-width stage reads as the middle, never as a turn.
  assert.equal(tapZone(0, 0, true), "menu");
  console.log("  ✓ tapZone: bands, RTL mirror, edges");
}

// --- swipe decisions ------------------------------------------------------------
{
  // LTR: finger to the left turns forward; RTL: finger to the right.
  assert.equal(swipeStep(-120, -0.2, false), 1);
  assert.equal(swipeStep(120, 0.2, false), -1);
  assert.equal(swipeStep(120, 0.2, true), 1);
  assert.equal(swipeStep(-120, -0.2, true), -1);
  // Short and slow stays.
  assert.equal(swipeStep(SWIPE_COMMIT_PX - 1, 0.1, true), 0);
  // Short but fast commits by its velocity.
  assert.equal(swipeStep(20, 0.8, true), 1);
  // Far, but flicked back at release: a hesitation cancels.
  assert.equal(swipeStep(150, -0.9, true), 0);
  console.log("  ✓ swipeStep: direction per reading order, distance/velocity, hesitation");
}

// --- the manga pager's verdict on a released drag -------------------------------
{
  const w = 400;
  // Past 28% of the stage: turns, whichever way the finger was going slowly.
  assert.equal(pagerTurn(w * 0.3, 0, w), 1, "right-to-left: travel to the right is forward");
  assert.equal(pagerTurn(-w * 0.3, 0, w), -1);
  // Short, but flung past half the stage by its momentum: turns.
  assert.equal(pagerTurn(40, 2000, w), 1); // lands at 40 + 198 px, past 200
  // Short and slow: stays.
  assert.equal(pagerTurn(40, 0, w), 0);
  // Far, but thrown back the other way at release: stays.
  assert.equal(pagerTurn(w * 0.4, -3000, w), 0);
  // Not moved at all: stays (a tap is not a drag).
  assert.equal(pagerTurn(0, 2000, w), 0);
  const { vx, vy } = velocityOf([
    { x: 0, y: 0, t: 0 },
    { x: 10, y: 5, t: 10 },
    { x: 20, y: 10, t: 20 },
  ]);
  assert.ok(vx > 900 && vx < 1100 && vy > 400 && vy < 600, `release velocity in px/s on both axes (${vx}, ${vy})`);
  console.log("  ✓ pagerTurn: share, momentum, hesitation; velocityOf in px/s");
}

// --- release velocity -----------------------------------------------------------
{
  const samples = [
    { x: 0, t: 0 },
    { x: 10, t: 300 }, // stale: outside the 100ms window
    { x: 20, t: 400 },
    { x: 60, t: 450 },
    { x: 100, t: 500 },
  ];
  // Window covers t=400..500 → 80px over 100ms.
  assert.equal(releaseVelocity(samples), 0.8);
  assert.equal(releaseVelocity([]), 0);
  assert.equal(releaseVelocity([{ x: 5, t: 10 }]), 0);
  console.log("  ✓ releaseVelocity: windowed, empty-safe");
}

// --- spring ----------------------------------------------------------------------
{
  // Critically damped: reaches the target without overshoot and settles.
  let x = 0;
  let v = 0;
  let maxX = 0;
  let frames = 0;
  while (!springSettled(x, v, 100) && frames < 2000) {
    ({ x, v } = springStep(x, v, 100, 1 / 240, 1, 0.3));
    maxX = Math.max(maxX, x);
    frames += 1;
  }
  assert.ok(frames < 2000, "critically damped spring settles");
  assert.ok(maxX <= 100.5, `no overshoot at damping 1 (max ${maxX})`);
  // Settles in roughly its response time (≈0.3s → well under 1s).
  assert.ok(frames / 240 < 1, `settles within a second (${frames / 240}s)`);
  // Under-damped overshoots.
  x = 0;
  v = 0;
  maxX = 0;
  for (let i = 0; i < 480; i++) {
    ({ x, v } = springStep(x, v, 100, 1 / 240, 0.5, 0.3));
    maxX = Math.max(maxX, x);
  }
  assert.ok(maxX > 105, "damping 0.5 overshoots");
  // A release velocity carries into the motion (handoff with no seam).
  const kicked = springStep(0, 2000, 0, 1 / 240, 1, 0.3);
  assert.ok(kicked.x > 0, "initial velocity moves the value first");
  console.log("  ✓ spring: settles, no overshoot at 1, bounce below 1, velocity handoff");
}

{
  // Momentum projection grows with velocity and keeps its sign.
  assert.equal(projectMomentum(0), 0);
  assert.ok(projectMomentum(1000) > projectMomentum(500));
  assert.ok(projectMomentum(-1000) < 0);
  // Rubber band: follows less than 1:1, monotonic, symmetric, bounded.
  assert.ok(rubberband(100, 440) < 100);
  assert.ok(rubberband(200, 440) > rubberband(100, 440));
  assert.equal(rubberband(-100, 440), -rubberband(100, 440));
  assert.ok(rubberband(100_000, 440) < 440);
  console.log("  ✓ projectMomentum and rubberband");
}

// --- frame-by-frame motion ----------------------------------------------------------
/** Drive an rAF animation on a 60 Hz clock; every value it painted, in order. */
function framesOf(run: (onFrame: (value: number) => void) => void): number[] {
  const queue: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (cb) => queue.push(cb);
  globalThis.cancelAnimationFrame = () => {};
  const values: number[] = [];
  run((value) => values.push(value));
  let now = performance.now();
  for (let i = 0; i < 1000 && queue.length > 0; i++) {
    now += 1000 / 60;
    queue.shift()!(now);
  }
  return values;
}
const steps = (values: readonly number[]) =>
  values.map((value, i) => value - (values[i - 1] ?? 0));

{
  // Regression (phone recording): the release spring ran on a 0→1 progress
  // but stopped by pixel thresholds, so it called itself done at k≈0.5 and
  // the page teleported the other half in one frame, then froze.
  const values = framesOf((onFrame) => animateProgress(onFrame, { response: 0.3 }));
  const moves = steps(values);
  assert.ok(Math.max(...moves) < 0.2, `no frame jumps: largest ${Math.max(...moves).toFixed(3)}`);
  assert.equal(values.at(-1), 1, "lands exactly on the target");
  assert.ok(moves.at(-1)! < 0.002, `arrives at rest: last step ${moves.at(-1)!.toFixed(4)}`);
  console.log("  ✓ animateProgress: no jump, lands on target at rest");
}

{
  // A pan released at 600 px/s glides 120 px over a 0.2 s constant: the first
  // frame keeps the finger's speed (10 px per frame), every later one is
  // slower, and it comes to rest exactly on the target with no jump.
  const px = framesOf((onFrame) => animateGlide(0.2, 0.25 / 120, (k) => onFrame(k * 120)));
  const moves = steps(px);
  assert.ok(Math.abs(moves[0]! - 10) < 1, `leaves at the finger's speed: ${moves[0]!.toFixed(2)} px`);
  for (let i = 1; i < moves.length - 1; i++)
    assert.ok(moves[i]! < moves[i - 1]!, `only slows down (frame ${i}: ${moves[i]!.toFixed(3)} px)`);
  assert.equal(px.at(-1), 120, "ends on the target");
  assert.ok(moves.at(-1)! <= 0.3, `the last step is invisible: ${moves.at(-1)!.toFixed(3)} px`);
  console.log("  ✓ animateGlide: continues the finger, only slows, no jump");
}

// --- manga neighbour sets ---------------------------------------------------------
{
  // Single pages: one by one, nothing past either edge.
  assert.equal(neighborFirst(1, 1, false, 10, true), 2);
  assert.equal(neighborFirst(10, 1, false, 10, true), null);
  assert.equal(neighborFirst(1, -1, false, 10, true), null);
  assert.equal(neighborFirst(5, -1, false, 10, true), 4);
  // Spreads with a solo cover: [1] → [2,3] → [4,5] … and back.
  assert.equal(neighborFirst(1, 1, true, 10, true), 2);
  assert.equal(neighborFirst(2, 1, true, 10, true), 4);
  assert.equal(neighborFirst(4, -1, true, 10, true), 2);
  assert.equal(neighborFirst(2, -1, true, 10, true), 1);
  // Last spread: [10] alone after [8,9] (10 pages, cover alone).
  assert.equal(neighborFirst(8, 1, true, 10, true), 10);
  assert.equal(neighborFirst(10, 1, true, 10, true), null);
  // Without the cover rule: [1,2] → [3,4] … and back.
  assert.equal(neighborFirst(1, 1, true, 10, false), 3);
  assert.equal(neighborFirst(3, -1, true, 10, false), 1);
  assert.equal(neighborFirst(9, 1, true, 10, false), null);
  // Every neighbour is a real spread start whose set is what the view shows.
  for (const cover of [true, false]) {
    for (let first = 1; first <= 11; first = neighborFirst(first, 1, true, 11, cover) ?? 99) {
      assert.equal(spreadFirstOf(first, cover), first, `spread start ${first}`);
      assert.ok(visibleNums(first, true, 11, cover).length >= 1);
    }
  }
  console.log("  ✓ neighborFirst: single, cover spreads, plain spreads, edges");
}

// --- zoom pan bounds ----------------------------------------------------------------
{
  const layer = { width: 400, height: 600 };
  const stage = { width: 440, height: 800 };
  // Fitted (zoom 1, smaller than the stage): pinned to center.
  assert.deepEqual(clampPan({ zoom: 1, x: 50, y: -40 }, layer, stage), { zoom: 1, x: 0, y: 0 });
  // Zoom 2: 800×1200 over 440×800 → ±180 / ±200 of travel.
  assert.deepEqual(clampPan({ zoom: 2, x: 999, y: -999 }, layer, stage), { zoom: 2, x: 180, y: -200 });
  assert.deepEqual(clampPan({ zoom: 2, x: 10, y: 20 }, layer, stage), { zoom: 2, x: 10, y: 20 });
  console.log("  ✓ clampPan: centered when small, bounded when zoomed");
}

console.log("reader-touch-unit: all checks passed");
