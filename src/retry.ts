import { GhlHttpError } from "./ghl-port.ts";

export interface RetryOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY: RetryOptions = { retries: 5, baseMs: 500, maxMs: 15_000 };

export function isRetryable(err: unknown): boolean {
  return err instanceof GhlHttpError && (err.status === 429 || err.status >= 500);
}

/** Retries 429 and 5xx with exponential backoff, honoring `Retry-After` when present. */
export function makeCaller(options: RetryOptions, sleep: (ms: number) => Promise<void>) {
  let retries = 0;

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isRetryable(err) || attempt >= options.retries) throw err;
        retries++;
        const backoff = Math.min(options.maxMs, options.baseMs * 2 ** attempt);
        await sleep((err as GhlHttpError).retryAfterMs ?? backoff);
      }
    }
  }

  return { call, retries: () => retries };
}

/** Runs one GHL operation with the retry policy applied. */
export type Invoke = <T>(fn: () => Promise<T>) => Promise<T>;
