import assert from "node:assert/strict";
import { test } from "node:test";
import { isTollFree, toE164 } from "../src/phone.ts";

test("normalizes common US formats to E.164", () => {
  for (const raw of ["+1 (555) 201-0001", "555.201.0001", "5552010001", "1-555-201-0001", "+15552010001"]) {
    assert.equal(toE164(raw), "+15552010001", raw);
  }
});

test("rejects numbers that are not dialable NANP numbers", () => {
  for (const raw of ["555-0199", "", undefined, null, "+44 20 7946 0958", "155520100011", "(055) 201-0001", "(555) 101-0001"]) {
    assert.equal(toE164(raw), null, String(raw));
  }
});

test("detects toll-free area codes", () => {
  assert.equal(isTollFree("+18005550142"), true);
  assert.equal(isTollFree("+18885550177"), true);
  assert.equal(isTollFree("+15552010001"), false);
});
