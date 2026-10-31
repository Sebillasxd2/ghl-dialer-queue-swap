// The GHL behaviors the swap is built around, pinned against the fake so the
// rest of the suite can rely on them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock } from "../src/clock.ts";
import { FakeGhl } from "../src/fake-ghl.ts";
import { rep } from "./helpers.ts";

function location(indexLagMs = 0) {
  const clock = new ManualClock(0);
  return { clock, ghl: new FakeGhl({ clock, indexLagMs, triggers: { [rep.queueTag]: rep.workflowId } }) };
}

test("adding a tag the contact already has is a silent no-op: no error, no trigger", async () => {
  const { ghl } = location();
  const contact = ghl.seed({ phone: "+15552010001", tags: [rep.queueTag], assignedTo: rep.ghlUserId });

  await ghl.addTag(contact.id, rep.queueTag); // resolves fine

  assert.deepEqual(ghl.enrolledIn(rep.workflowId), [], "the workflow never fired");
  assert.equal(ghl.visibleQueue(rep.ghlUserId, rep.workflowId).length, 0);
});

test("remove-then-add turns the same tag into a real 'tag added' event", async () => {
  const { ghl } = location();
  const contact = ghl.seed({ phone: "+15552010001", tags: [rep.queueTag], assignedTo: rep.ghlUserId });

  await ghl.removeTag(contact.id, rep.queueTag);
  await ghl.addTag(contact.id, rep.queueTag);

  assert.deepEqual(ghl.enrolledIn(rep.workflowId), [contact.id]);
});

test("removing the tag does not take the contact out of the workflow", async () => {
  const { ghl } = location();
  const contact = ghl.seed({ phone: "+15552010001", assignedTo: rep.ghlUserId });
  await ghl.addTag(contact.id, rep.queueTag);

  await ghl.removeTag(contact.id, rep.queueTag);

  assert.deepEqual(ghl.visibleQueue(rep.ghlUserId, rep.workflowId).map((c) => c.id), [contact.id], "still dialable: a ghost");
});

test("a queued contact without assignedTo is invisible to a restricted rep", async () => {
  const { ghl } = location();
  const contact = ghl.seed({ phone: "+15552010001" });
  await ghl.addTag(contact.id, rep.queueTag);

  assert.deepEqual(ghl.enrolledIn(rep.workflowId), [contact.id], "enrolled");
  assert.equal(ghl.visibleQueue(rep.ghlUserId, rep.workflowId).length, 0, "but the rep's queue is empty");
});

test("search trails writes; reading the contact by id does not", async () => {
  const { clock, ghl } = location(3_000);
  const contact = ghl.seed({ phone: "+15552010001" });
  await ghl.addTag(contact.id, rep.queueTag);

  assert.equal((await ghl.searchContacts({ tag: rep.queueTag })).contacts.length, 0, "not indexed yet");
  assert.deepEqual((await ghl.getContact(contact.id)).tags, [rep.queueTag], "the record itself is current");

  await clock.sleep(3_000);
  assert.equal((await ghl.searchContacts({ tag: rep.queueTag })).contacts.length, 1);
});
