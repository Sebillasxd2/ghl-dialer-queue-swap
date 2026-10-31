import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildLeakyLocation, DEMO_NOW } from "./demo.ts";
import { createHttpPort } from "./ghl-http.ts";
import { countSkips, DEFAULT_PLAN_OPTIONS, planQueue } from "./plan.ts";
import { isClean, swapQueue, type SwapReport } from "./swap.ts";
import type { Call, Lead, Rep } from "./types.ts";

const USAGE = `usage:
  node src/cli.ts plan  [--leads f] [--calls f] [--now iso] [--cap n] [--cool-off-days n]
  node src/cli.ts demo  run a full swap against the in-memory fake location
  node src/cli.ts swap  --live --reps <file> --rep <id> [--leads f] [--calls f]
                        the rep record must carry the account's real ghlUserId, queueTag and workflowId;
                        needs GHL_API_TOKEN and GHL_LOCATION_ID in the environment`;

const options = {
  leads: { type: "string", default: "fixtures/leads.json" },
  calls: { type: "string", default: "fixtures/calls.json" },
  reps: { type: "string", default: "fixtures/reps.json" },
  rep: { type: "string" },
  now: { type: "string" },
  cap: { type: "string" },
  "cool-off-days": { type: "string" },
  live: { type: "boolean", default: false },
} as const;

// parseArgs throws on an unknown flag or a value that looks like one: answer with usage and exit 2.
let args: ReturnType<typeof parseArgs<{ allowPositionals: true; options: typeof options }>>;
try {
  args = parseArgs({ allowPositionals: true, options });
} catch (err) {
  console.error(`${(err as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
const { positionals, values } = args;

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const leads = readJson<Lead[]>(values.leads);
const calls = readJson<Call[]>(values.calls);
const reps = readJson<Rep[]>(values.reps);
const planOptions = {
  now: new Date(values.now ?? (values.live ? new Date().toISOString() : DEMO_NOW)),
  cap: values.cap !== undefined ? Number(values.cap) : DEFAULT_PLAN_OPTIONS.cap,
  coolOffDays: values["cool-off-days"] !== undefined ? Number(values["cool-off-days"]) : DEFAULT_PLAN_OPTIONS.coolOffDays,
};
// A typo here must stop the run: an invalid date turns the cool-off filter off without a word.
const badInput = [
  Number.isNaN(planOptions.now.getTime()) && `--now "${values.now}" is not a date`,
  !(Number.isInteger(planOptions.cap) && planOptions.cap >= 0) && `--cap "${values.cap}" is not a whole number`,
  !(Number.isFinite(planOptions.coolOffDays) && planOptions.coolOffDays >= 0) && `--cool-off-days "${values["cool-off-days"]}" is not a number of days`,
].filter(Boolean);
if (badInput.length) {
  console.error(`${badInput.join("\n")}\n\n${USAGE}`);
  process.exit(2);
}

switch (positionals[0]) {
  case "plan": {
    const plan = planQueue(leads, calls, planOptions);
    console.log(`selected ${plan.selected.length}`);
    for (const lead of plan.selected) console.log(`  ${lead.phone}  ${(lead.lineType ?? "unknown").padEnd(8)}  ${lead.company}`);
    console.log("skipped", countSkips(plan));
    break;
  }
  case "demo": {
    const [rep, otherRep] = reps;
    if (!rep || !otherRep) throw new Error("fixtures/reps.json needs two reps");
    const { clock, ghl } = buildLeakyLocation(rep, otherRep, { rateLimitEvery: 9 });
    console.log(`before: ${rep.name} sees ${ghl.visibleQueue(rep.ghlUserId, rep.workflowId).length} contacts`);
    const report = await swapQueue(ghl, rep, leads, calls, { ...planOptions, clock });
    printReport(report);
    console.log(`after:  ${rep.name} sees ${ghl.visibleQueue(rep.ghlUserId, rep.workflowId).length} contacts`);
    console.log(`other rep untouched: ${ghl.visibleQueue(otherRep.ghlUserId, otherRep.workflowId).length} contact(s)`);
    break;
  }
  case "swap": {
    const token = process.env.GHL_API_TOKEN;
    const locationId = process.env.GHL_LOCATION_ID;
    const rep = reps.find((r) => r.id === values.rep);
    if (!values.live || !token || !locationId || !rep) {
      console.error("swap writes to a real location: pass --live, --reps with your own rep records and --rep, and set GHL_API_TOKEN and GHL_LOCATION_ID");
      process.exit(2);
    }
    printReport(await swapQueue(createHttpPort({ token, locationId }), rep, leads, calls, planOptions));
    break;
  }
  default:
    console.log(USAGE);
    process.exit(positionals[0] ? 2 : 0);
}

function printReport(report: SwapReport): void {
  console.log(`status: ${report.status}${report.reason ? ` (${report.reason})` : ""}`);
  console.log(`plan:   ${report.plan.selected} selected, skipped`, report.plan.skipped);
  if (report.wipe) {
    const { passes, removed, verifiedEmpty, errors } = report.wipe;
    console.log(`wipe:   ${removed.length} removed in ${passes} passes, verified empty: ${verifiedEmpty}, errors: ${errors.length}`);
  }
  if (report.load) console.log(`load:   ${report.load.loaded.length} loaded, ${report.load.failed.length} failed`);
  if (report.verify) console.log(`verify: ${report.verify.ok ? "ok" : `${report.verify.mismatches.length} mismatches`}`);
  console.log(`retries after 429/5xx: ${report.retries}`);
  // A scheduler only sees the exit code: anything short of a clean load is a failure.
  if (!isClean(report)) process.exitCode = 1;
}
