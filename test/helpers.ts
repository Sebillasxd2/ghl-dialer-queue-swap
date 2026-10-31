import { readFileSync } from "node:fs";
import type { Call, Lead, Rep } from "../src/types.ts";
import type { WipeOptions } from "../src/wipe.ts";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;

export const leads = fixture<Lead[]>("leads.json");
export const calls = fixture<Call[]>("calls.json");
export const [rep, otherRep] = fixture<[Rep, Rep]>("reps.json");

export const NOW = new Date("2026-03-10T15:00:00Z");

/** Settle longer than the fake's 3s index lag. */
export const WIPE: WipeOptions = { settleMs: 4_000, confirmPasses: 2, maxPasses: 8, protectedTags: ["booked"] };

export const RETRY = { retries: 3, baseMs: 100, maxMs: 1_000 };
