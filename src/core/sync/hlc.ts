// Hybrid logical clock for register timestamps: wall-clock milliseconds that
// never run backwards and always land after anything already seen, so "I saw
// your change, then made mine" wins even when the two devices' clocks
// disagree. A remote stamp more than MAX_DRIFT_MS ahead of this device's
// clock is not trusted (a skewed clock must not win for hours — Readest's
// bug): the register waits until the local clock catches up.

export const MAX_DRIFT_MS = 5 * 60 * 1000;

export class Hlc {
  private last: number;
  private readonly clock: () => number;

  constructor(last = 0, clock: () => number = Date.now) {
    this.last = last;
    this.clock = clock;
  }

  /** A fresh stamp for a local edit. */
  now(): number {
    this.last = Math.max(this.clock(), this.last + 1);
    return this.last;
  }

  /** Fold in a remote stamp; false = from the future, ignore that value. */
  observe(t: number): boolean {
    if (!this.trusts(t)) return false;
    if (t > this.last) this.last = t;
    return true;
  }

  trusts(t: number): boolean {
    return t <= this.clock() + MAX_DRIFT_MS;
  }

  /** The highest stamp issued or seen — persisted between sessions. */
  get value(): number {
    return this.last;
  }
}
