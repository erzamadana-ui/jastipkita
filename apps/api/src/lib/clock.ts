export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Controllable clock for tests. */
export class FixedClock implements Clock {
  constructor(private t: Date) {}
  now(): Date {
    return new Date(this.t.getTime());
  }
  set(t: Date): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}
