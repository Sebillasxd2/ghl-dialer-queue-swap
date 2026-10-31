import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLeakyLocation } from "../src/demo.ts";
import type { Fault } from "../src/fake-ghl.ts";
import { swapQueue } from "../src/swap.ts";
import { calls, leads, NOW, otherRep, rep, RETRY, WIPE } from "./helpers.ts";

async function run(options: { rateLimitEvery?: number; faults?: Fault[]; leads?: typeof leads } = {}) {
  const { clock, ghl } = buildLeakyLocation(rep, otherRep, options);
  const report = await swapQueue(ghl, rep, options.leads ?? leads, calls, {
    now: NOW,
    coolOffDays: 7,
    cap: 250,
    wipe: WIPE,
    retry: RETRY,
    clock,
  });
  return { ghl, report };
}

test("swaps a leaky queue for today's plan, through rate limiting", async () => {
  const { ghl, report } = await run({ rateLimitEvery: 9 });

  assert.equal(report.status, "loaded");
  assert.equal(report.verify?.ok, true);
  assert.ok(report.retries > 0, "429s were absorbed");

  const visible = ghl.visibleQueue(rep.ghlUserId, rep.workflowId).map((c) => c.id).sort();
  const loaded = report.load!.loaded.map((row) => row.contactId).sort();
  assert.equal(loaded.length, 12);
  assert.deepEqual(visible, loaded, "the rep sees exactly today's plan, nothing from yesterday");
  assert.deepEqual(ghl.enrolledIn(otherRep.workflowId), ["ct_other_0001"], "other rep untouched");
});

test("a wipe that keeps failing blocks the load entirely", async () => {
  const { ghl, report } = await run({ faults: [{ op: "removeFromWorkflow", contactId: "ct_ghost_0001", status: 500 }] });

  assert.equal(report.status, "aborted");
  assert.equal(report.reason, "wipe_not_verified");
  assert.ok(report.wipe?.errors.some((e) => e.contactId === "ct_ghost_0001"));
  assert.equal(ghl.count("upsertContact"), 0, "not a single contact was loaded on top of leftovers");
});

test("a write that answers 200 but does nothing is caught by the verification loop", async () => {
  const { ghl, report } = await run({ faults: [{ op: "removeTag", contactId: "ct_old_0002", silent: true }] });

  assert.equal(report.status, "aborted");
  assert.equal(report.reason, "wipe_not_verified");
  assert.deepEqual(report.wipe?.errors, [], "nothing ever errored");
  assert.equal(ghl.count("upsertContact"), 0);
});

test("an empty plan never blanks yesterday's queue", async () => {
  const { ghl, report } = await run({ leads: leads.filter((lead) => lead.lineType === "toll_free") });

  assert.equal(report.status, "aborted");
  assert.equal(report.reason, "nothing_to_load");
  assert.equal(ghl.visibleQueue(rep.ghlUserId, rep.workflowId).length, 7, "yesterday's queue is still there");
  assert.equal(ghl.log.length, 0, "no request was made");
});

test("verification reads records back and flags a tag that silently did not stick", async () => {
  const { report } = await run({ faults: [{ op: "addTag", silent: true, times: 1 }] });

  assert.equal(report.status, "loaded");
  assert.equal(report.verify?.ok, false);
  assert.equal(report.verify?.mismatches.length, 1);
  assert.equal(report.verify?.mismatches[0]?.problem, "missing_tag");
});
