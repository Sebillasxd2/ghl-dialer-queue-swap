import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock } from "../src/clock.ts";
import { FakeGhl } from "../src/fake-ghl.ts";
import { loadQueue } from "../src/load.ts";
import { makeCaller } from "../src/retry.ts";
import { rep } from "./helpers.ts";

function location() {
  const clock = new ManualClock(0);
  const ghl = new FakeGhl({ clock, triggers: { [rep.queueTag]: rep.workflowId } });
  return { ghl, ctx: { invoke: makeCaller({ retries: 0, baseMs: 0, maxMs: 0 }, (ms) => clock.sleep(ms)).call, source: "test" } };
}

const lead = { id: "ld_x", company: "Prairie Gate Dental", firstName: "Dana", phone: "+15552010001" };

test("a lead that matches a contact already carrying the tag still reaches the queue", async () => {
  const { ghl, ctx } = location();
  // Left behind by a manual edit: tagged, never enrolled, owned by nobody.
  const existing = ghl.seed({ phone: lead.phone, tags: [rep.queueTag] });

  const result = await loadQueue(ghl, rep, [lead], ctx);

  assert.deepEqual(result.loaded, [{ leadId: "ld_x", contactId: existing.id, created: false }]);
  assert.deepEqual(ghl.visibleQueue(rep.ghlUserId, rep.workflowId).map((c) => c.id), [existing.id]);
});

test("loaded contacts are owned by the rep and keep tags other processes set", async () => {
  const { ghl, ctx } = location();
  const existing = ghl.seed({ phone: lead.phone, tags: ["newsletter"] });

  await loadQueue(ghl, rep, [lead], ctx);

  const contact = ghl.peek(existing.id);
  assert.equal(contact?.assignedTo, rep.ghlUserId);
  assert.deepEqual(contact?.tags, ["newsletter", rep.queueTag]);
});

test("one failing lead does not stop the rest", async () => {
  const clock = new ManualClock(0);
  const ghl = new FakeGhl({
    clock,
    triggers: { [rep.queueTag]: rep.workflowId },
    faults: [{ op: "upsertContact", status: 422, times: 1 }],
  });
  const ctx = { invoke: makeCaller({ retries: 2, baseMs: 10, maxMs: 10 }, (ms) => clock.sleep(ms)).call, source: "test" };

  const result = await loadQueue(ghl, rep, [lead, { ...lead, id: "ld_y", phone: "+15552010002" }], ctx);

  assert.equal(result.failed.length, 1, "422 is not retried");
  assert.equal(result.failed[0]?.leadId, "ld_x");
  assert.equal(result.loaded.length, 1);
});
