import { ManualClock } from "./clock.ts";
import { FakeGhl, type Fault } from "./fake-ghl.ts";
import type { Rep } from "./types.ts";

export const DEMO_NOW = "2026-03-10T15:00:00Z";

/**
 * A location where yesterday's queue for `rep` was left in the state real queues end
 * up in: tagged contacts, a ghost that lost its tag but is still enrolled, a contact
 * the search index has not caught up with, a booked contact that must keep its owner,
 * and another rep's contact that must not be touched.
 */
export function buildLeakyLocation(
  rep: Rep,
  otherRep: Rep,
  options: { rateLimitEvery?: number; faults?: Fault[] } = {},
) {
  const clock = new ManualClock(Date.parse(DEMO_NOW));
  const ghl = new FakeGhl({
    clock,
    indexLagMs: 3_000,
    pageSize: 3,
    rateLimitEvery: options.rateLimitEvery ?? 0,
    faults: options.faults ?? [],
    triggers: { [rep.queueTag]: rep.workflowId, [otherRep.queueTag]: otherRep.workflowId },
  });

  const inQueue = { tags: [rep.queueTag], assignedTo: rep.ghlUserId };
  const enrolled = { enrolledIn: [rep.workflowId] };
  ghl.seed({ id: "ct_old_0001", phone: "+15553010001", companyName: "Old Lead One", ...inQueue }, enrolled);
  ghl.seed({ id: "ct_old_0002", phone: "+15553010002", companyName: "Old Lead Two", ...inQueue }, enrolled);
  ghl.seed({ id: "ct_old_0003", phone: "+15553010003", companyName: "Old Lead Three", ...inQueue }, enrolled);
  ghl.seed({ id: "ct_old_0004", phone: "+15553010004", companyName: "Old Lead Four", ...inQueue }, enrolled);
  // Tag removed by hand, still assigned and still enrolled: a ghost.
  ghl.seed({ id: "ct_ghost_0001", phone: "+15553010005", companyName: "Ghost Co", assignedTo: rep.ghlUserId }, enrolled);
  // Tagged a moment ago: search will not return it until the index catches up.
  ghl.seed(
    { id: "ct_lag_0001", phone: "+15553010006", companyName: "Late Index LLC", ...inQueue },
    { ...enrolled, justWritten: true },
  );
  // Booked: leaves the queue but keeps its owner.
  ghl.seed(
    { id: "ct_booked_0001", phone: "+15553010007", companyName: "Booked Inc", ...inQueue, tags: [rep.queueTag, "booked"] },
    enrolled,
  );
  // Someone else's queue.
  ghl.seed(
    { id: "ct_other_0001", phone: "+15553010008", companyName: "Other Rep Lead", tags: [otherRep.queueTag], assignedTo: otherRep.ghlUserId },
    { enrolledIn: [otherRep.workflowId] },
  );

  return { clock, ghl };
}
