/**
 * Deterministic RNG (mulberry32). The whole game seeds from one instance so the
 * screenshot harness can reproduce any frame exactly - `?seed=1337&t=12` always
 * yields the same picture, which is what makes visual regression checking real
 * rather than approximate.
 */
export class Rng {
  private s: number;

  constructor(seed = 1337) {
    this.s = seed >>> 0;
  }

  /** 0..1 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)] as T;
  }

  /** Signed -1..1 */
  signed(): number {
    return this.next() * 2 - 1;
  }

  fork(salt: number): Rng {
    return new Rng((this.s ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0);
  }
}

/** Global seed, overridable from the URL for the harness. */
export const SEED = (() => {
  if (typeof location === 'undefined') return 1337;
  const p = new URLSearchParams(location.search).get('seed');
  const n = p ? Number(p) : NaN;
  return Number.isFinite(n) ? n : 1337;
})();

export const rng = new Rng(SEED);
