import { systemClock, type Clock } from "./clock.ts";
import type { GhlPort } from "./ghl-port.ts";
import { loadQueue, verifyLoad, type LoadResult, type VerifyResult } from "./load.ts";
import { countSkips, planQueue, type PlanOptions, type SkipReason } from "./plan.ts";
import { DEFAULT_RETRY, makeCaller, type RetryOptions } from "./retry.ts";
import { DEFAULT_WIPE, wipeQueue, type WipeOptions, type WipeResult } from "./wipe.ts";
import type { Call, Lead, Rep } from "./types.ts";

export interface SwapOptions extends PlanOptions {
  wipe?: WipeOptions;
  retry?: RetryOptions;
  clock?: Clock;
  /** Written to the contact's `source` field so loaded contacts are traceable. */
  source?: string;
}

export interface SwapReport {
  status: "loaded" | "aborted";
  reason?: "nothing_to_load" | "wipe_not_verified";
  plan: { selected: number; skipped: Partial<Record<SkipReason, number>> };
  wipe?: WipeResult;
  load?: LoadResult;
  verify?: VerifyResult;
  retries: number;
}

/**
 * Replaces a rep's queue with today's plan: plan, wipe, gate, load, verify.
 *
 * The order matters. Planning first means an empty plan never blanks yesterday's
 * queue. The gate between wipe and load means a wipe that could not prove the queue
 * empty never gets new contacts piled on top of leftovers.
 */
export async function swapQueue(
  ghl: GhlPort,
  rep: Rep,
  leads: Lead[],
  calls: Call[],
  options: SwapOptions,
): Promise<SwapReport> {
  const clock = options.clock ?? systemClock;
  const caller = makeCaller(options.retry ?? DEFAULT_RETRY, (ms) => clock.sleep(ms));
  const invoke = caller.call;

  const plan = planQueue(leads, calls, options);
  const planSummary = { selected: plan.selected.length, skipped: countSkips(plan) };
  if (plan.selected.length === 0) {
    return { status: "aborted", reason: "nothing_to_load", plan: planSummary, retries: 0 };
  }

  const wipe = await wipeQueue(ghl, rep, options.wipe ?? DEFAULT_WIPE, { invoke, clock });
  if (!wipe.verifiedEmpty) {
    return {
      status: "aborted",
      reason: "wipe_not_verified",
      plan: planSummary,
      wipe,
      retries: caller.retries(),
    };
  }

  const load = await loadQueue(ghl, rep, plan.selected, {
    invoke,
    source: options.source ?? "dialer-queue-swap",
  });
  const verify = await verifyLoad(
    ghl,
    rep,
    load.loaded.map((row) => row.contactId),
    { invoke },
  );

  return { status: "loaded", plan: planSummary, wipe, load, verify, retries: caller.retries() };
}
