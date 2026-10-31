import assert from "node:assert/strict";
import { test } from "node:test";
import { GhlHttpError } from "../src/ghl-port.ts";
import { makeCaller } from "../src/retry.ts";

const policy = { retries: 4, baseMs: 100, maxMs: 250 };

test("backoff doubles and stops at maxMs", async () => {
  const slept: number[] = [];
  const caller = makeCaller(policy, async (ms) => void slept.push(ms));
  let attempts = 0;
  const result = await caller.call(async () => {
    if (++attempts < 5) throw new GhlHttpError(503, "unavailable");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.deepEqual(slept, [100, 200, 250, 250]);
});

test("Retry-After within the cap is honored exactly", async () => {
  const slept: number[] = [];
  const caller = makeCaller(policy, async (ms) => void slept.push(ms));
  let attempts = 0;
  await caller.call(async () => {
    if (++attempts === 1) throw new GhlHttpError(429, "slow down", 200);
    return "ok";
  });
  assert.deepEqual(slept, [200]);
});

test("Retry-After beyond the cap fails at once instead of sleeping or retrying early", async () => {
  const slept: number[] = [];
  const caller = makeCaller(policy, async (ms) => void slept.push(ms));
  let attempts = 0;
  await assert.rejects(
    caller.call(async () => {
      attempts++;
      throw new GhlHttpError(429, "daily limit", 86_400_000);
    }),
    (err: unknown) => err instanceof GhlHttpError && err.retryAfterMs === 86_400_000,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(slept, []);
  assert.equal(caller.retries(), 0);
});

test("4xx other than 429 is not retried", async () => {
  const caller = makeCaller(policy, async () => {});
  let attempts = 0;
  await assert.rejects(caller.call(async () => {
    attempts++;
    throw new GhlHttpError(422, "bad input");
  }));
  assert.equal(attempts, 1);
});
