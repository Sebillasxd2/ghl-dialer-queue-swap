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

/**
 * Retries 429 and 5xx with exponential backoff capped at `maxMs`, honoring
 * `Retry-After` when present. A `Retry-After` beyond `maxMs` is not slept and not
 * retried early: the error is rethrown at once, carrying the server's value.
 */
export function makeCaller(options: RetryOptions, sleep: (ms: number) => Promise<void>) {
  let retries = 0;

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isRetryable(err) || attempt >= options.retries) throw err;
        const retryAfter = (err as GhlHttpError).retryAfterMs;
        if (retryAfter !== undefined && retryAfter > options.maxMs) throw err;
        retries++;
        await sleep(retryAfter ?? Math.min(options.maxMs, options.baseMs * 2 ** attempt));
      }
    }
  }

  return { call, retries: () => retries };
}

/** Runs one GHL operation with the retry policy applied. */
export type Invoke = <T>(fn: () => Promise<T>) => Promise<T>;
