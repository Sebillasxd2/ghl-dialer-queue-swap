import { isTollFree, toE164 } from "./phone.ts";
import type { Call, Lead, LineType } from "./types.ts";

export type SkipReason = "invalid_phone" | "toll_free" | "duplicate_phone" | "cool_off" | "over_cap";

/** A lead that made it into the plan, with its phone already in E.164. */
export type PlannedLead = Lead & { phone: string };

export interface QueuePlan {
  selected: PlannedLead[];
  skipped: { lead: Lead; reason: SkipReason }[];
}

export interface PlanOptions {
  now: Date;
  /** Do not redial a number that was called within this many days. */
  coolOffDays: number;
  /** Hard cap on queue size per rep per day. */
  cap: number;
}

export const DEFAULT_PLAN_OPTIONS: Omit<PlanOptions, "now"> = { coolOffDays: 7, cap: 250 };

// Mobile first: on a cold list the cell phone is the one the owner answers.
const LINE_RANK: Record<LineType, number> = {
  mobile: 0,
  landline: 1,
  voip: 2,
  unknown: 3,
  toll_free: 4,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decides which leads go into today's queue. Pure: no GHL calls, so it can run (and
 * fail) before anything in the CRM is touched.
 */
export function planQueue(leads: Lead[], calls: Call[], options: PlanOptions): QueuePlan {
  const lastCalled = new Map<string, number>();
  for (const call of calls) {
    const phone = toE164(call.phone);
    if (!phone) continue;
    const at = Date.parse(call.calledAt);
    if (Number.isNaN(at)) continue;
    lastCalled.set(phone, Math.max(lastCalled.get(phone) ?? 0, at));
  }

  const skipped: QueuePlan["skipped"] = [];
  const eligible: PlannedLead[] = [];
  const seen = new Set<string>();
  const coolOffStart = options.now.getTime() - options.coolOffDays * DAY_MS;

  for (const lead of leads) {
    const phone = toE164(lead.phone);
    if (!phone) {
      skipped.push({ lead, reason: "invalid_phone" });
    } else if (lead.lineType === "toll_free" || isTollFree(phone)) {
      skipped.push({ lead, reason: "toll_free" });
    } else if (seen.has(phone)) {
      skipped.push({ lead, reason: "duplicate_phone" });
    } else if ((lastCalled.get(phone) ?? -Infinity) > coolOffStart) {
      seen.add(phone);
      skipped.push({ lead, reason: "cool_off" });
    } else {
      seen.add(phone);
      eligible.push({ ...lead, phone });
    }
  }

  // Array.prototype.sort is stable, so leads keep their input order within a line type.
  eligible.sort((a, b) => LINE_RANK[a.lineType ?? "unknown"] - LINE_RANK[b.lineType ?? "unknown"]);

  const selected = eligible.slice(0, options.cap);
  for (const lead of eligible.slice(options.cap)) skipped.push({ lead, reason: "over_cap" });
  return { selected, skipped };
}

export function countSkips(plan: QueuePlan): Partial<Record<SkipReason, number>> {
  const counts: Partial<Record<SkipReason, number>> = {};
  for (const { reason } of plan.skipped) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}
