export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A clock that only moves when someone sleeps. Keeps settle and backoff tests instant. */
export class ManualClock implements Clock {
  private current: number;
  slept = 0;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.current += ms;
    this.slept += ms;
  }
}
