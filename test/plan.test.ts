import assert from "node:assert/strict";
import { test } from "node:test";
import { countSkips, planQueue } from "../src/plan.ts";
import type { Lead } from "../src/types.ts";
import { calls, leads, NOW } from "./helpers.ts";

const opts = { now: NOW, coolOffDays: 7, cap: 250 };

test("skips invalid, toll-free, duplicate and recently dialed numbers", () => {
  const plan = planQueue(leads, calls, opts);
  const reasons = Object.fromEntries(plan.skipped.map(({ lead, reason }) => [lead.id, reason]));
  assert.deepEqual(reasons, {
    ld_003: "toll_free", // landline in the data, but the number is toll-free
    ld_006: "invalid_phone",
    ld_008: "duplicate_phone",
    ld_009: "cool_off", // called 3 days ago
    ld_014: "cool_off", // called 6 days ago, history stored in another format
    ld_016: "toll_free",
  });
  assert.equal(plan.selected.length, leads.length - 6);
  assert.ok(plan.selected.some((lead) => lead.id === "ld_010"), "called 9 days ago is eligible again");
});

test("cool-off boundary is exclusive: exactly N days ago is dialable", () => {
  const lead: Lead = { id: "x", company: "Edge Case Co", phone: "+15552019999" };
  const at = (iso: string) => [{ phone: lead.phone, calledAt: iso, repId: "r", outcome: "no_answer" }];
  assert.equal(planQueue([lead], at("2026-03-03T15:00:00Z"), opts).selected.length, 1);
  assert.equal(planQueue([lead], at("2026-03-03T15:00:01Z"), opts).selected.length, 0);
});

test("orders mobile first and keeps input order inside each line type", () => {
  const plan = planQueue(leads, calls, opts);
  const types = plan.selected.map((lead) => lead.lineType ?? "unknown");
  const rank = { mobile: 0, landline: 1, voip: 2, unknown: 3, toll_free: 4 };
  for (let i = 1; i < types.length; i++) assert.ok(rank[types[i - 1]!] <= rank[types[i]!], types.join(","));
  assert.deepEqual(
    plan.selected.filter((lead) => lead.lineType === "mobile").map((lead) => lead.id),
    ["ld_002", "ld_004", "ld_010", "ld_012", "ld_015", "ld_018"],
  );
});

test("caps the queue and reports the overflow", () => {
  const many: Lead[] = Array.from({ length: 300 }, (_, i) => ({
    id: `bulk_${i}`,
    company: `Bulk Co ${i}`,
    phone: `+1555300${String(i).padStart(4, "0")}`,
    lineType: i % 2 ? "mobile" : "landline",
  }));
  const plan = planQueue(many, [], opts);
  assert.equal(plan.selected.length, 250);
  assert.deepEqual(countSkips(plan), { over_cap: 50 });
  assert.equal(plan.selected.filter((lead) => lead.lineType === "mobile").length, 150, "all mobiles made the cut");
});

test("phones in the plan are E.164", () => {
  for (const lead of planQueue(leads, calls, opts).selected) assert.match(lead.phone, /^\+1\d{10}$/);
});
