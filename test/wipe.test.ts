import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock } from "../src/clock.ts";
import { buildLeakyLocation } from "../src/demo.ts";
import { FakeGhl } from "../src/fake-ghl.ts";
import { makeCaller } from "../src/retry.ts";
import { wipeQueue } from "../src/wipe.ts";
import { otherRep, rep, RETRY, WIPE } from "./helpers.ts";

function setup(options: Parameters<typeof buildLeakyLocation>[2] = {}) {
  const { clock, ghl } = buildLeakyLocation(rep, otherRep, options);
  const caller = makeCaller(RETRY, (ms) => clock.sleep(ms));
  return { clock, ghl, caller, ctx: { invoke: caller.call, clock } };
}

test("a seeded leak is fully drained: tagged, ghost, late-indexed and booked contacts", async () => {
  const { ghl, ctx } = setup();
  assert.equal(ghl.visibleQueue(rep.ghlUserId, rep.workflowId).length, 7);

  const result = await wipeQueue(ghl, rep, WIPE, ctx);

  assert.equal(result.verifiedEmpty, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(ghl.enrolledIn(rep.workflowId), [], "nobody left in the workflow");
  assert.ok(result.removed.includes("ct_ghost_0001"), "the ghost was found through the owner search");
  assert.ok(result.removed.includes("ct_lag_0001"), "the late-indexed contact was caught on a later pass");
});

test("protected contacts leave the queue but keep their owner", async () => {
  const { ghl, ctx } = setup();
  await wipeQueue(ghl, rep, WIPE, ctx);

  const booked = ghl.peek("ct_booked_0001");
  assert.equal(booked?.assignedTo, rep.ghlUserId);
  assert.deepEqual(booked?.tags, ["booked"]);
  assert.equal(ghl.peek("ct_old_0001")?.assignedTo, null, "ordinary contacts are released");
});

test("another rep's queue is not touched", async () => {
  const { ghl, ctx } = setup();
  await wipeQueue(ghl, rep, WIPE, ctx);
  assert.deepEqual(ghl.enrolledIn(otherRep.workflowId), ["ct_other_0001"]);
  assert.equal(ghl.peek("ct_other_0001")?.assignedTo, otherRep.ghlUserId);
});

test("a single empty search is not trusted while the index lags", async () => {
  const onlyLate = () => {
    const clock = new ManualClock(0);
    const ghl = new FakeGhl({ clock, indexLagMs: 3_000 });
    ghl.seed(
      { id: "ct_late_0001", phone: "+15553019999", tags: [rep.queueTag], assignedTo: rep.ghlUserId },
      { enrolledIn: [rep.workflowId], justWritten: true },
    );
    return { ghl, ctx: { invoke: makeCaller(RETRY, (ms) => clock.sleep(ms)).call, clock } };
  };

  const naive = onlyLate();
  const trusting = await wipeQueue(naive.ghl, rep, { ...WIPE, confirmPasses: 1, settleMs: 0 }, naive.ctx);
  assert.equal(trusting.verifiedEmpty, true, "one empty search and it calls the queue empty");
  assert.deepEqual(naive.ghl.enrolledIn(rep.workflowId), ["ct_late_0001"], "while the contact is still queued");

  const careful = onlyLate();
  const settled = await wipeQueue(careful.ghl, rep, WIPE, careful.ctx);
  assert.equal(settled.verifiedEmpty, true);
  assert.deepEqual(careful.ghl.enrolledIn(rep.workflowId), [], "settling past the lag finds it");
});

test("survives 429s by backing off and retrying", async () => {
  const { ghl, caller, ctx } = setup({ rateLimitEvery: 4 });
  const result = await wipeQueue(ghl, rep, WIPE, ctx);
  assert.equal(result.verifiedEmpty, true);
  assert.ok(caller.retries() > 0, "some requests were rate limited");
  assert.deepEqual(ghl.enrolledIn(rep.workflowId), []);
});
