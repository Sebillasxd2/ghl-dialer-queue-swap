import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildLeakyLocation, DEMO_NOW } from "./demo.ts";
import { createHttpPort } from "./ghl-http.ts";
import { countSkips, DEFAULT_PLAN_OPTIONS, planQueue } from "./plan.ts";
import { swapQueue, type SwapReport } from "./swap.ts";
import type { Call, Lead, Rep } from "./types.ts";

const USAGE = `usage:
  node src/cli.ts plan  [--leads f] [--calls f] [--now iso] [--cap n] [--cool-off-days n]
  node src/cli.ts demo  run a full swap against the in-memory fake location
  node src/cli.ts swap  --live --rep <id> [--leads f] [--calls f]
                        needs GHL_API_TOKEN and GHL_LOCATION_ID in the environment`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    leads: { type: "string", default: "fixtures/leads.json" },
    calls: { type: "string", default: "fixtures/calls.json" },
    reps: { type: "string", default: "fixtures/reps.json" },
    rep: { type: "string" },
    now: { type: "string" },
    cap: { type: "string" },
    "cool-off-days": { type: "string" },
    live: { type: "boolean", default: false },
  },
});

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const leads = readJson<Lead[]>(values.leads);
const calls = readJson<Call[]>(values.calls);
const reps = readJson<Rep[]>(values.reps);
const planOptions = {
  now: new Date(values.now ?? (values.live ? new Date().toISOString() : DEMO_NOW)),
  cap: values.cap ? Number(values.cap) : DEFAULT_PLAN_OPTIONS.cap,
  coolOffDays: values["cool-off-days"] ? Number(values["cool-off-days"]) : DEFAULT_PLAN_OPTIONS.coolOffDays,
};

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
      console.error("swap writes to a real location: pass --live and --rep, and set GHL_API_TOKEN and GHL_LOCATION_ID");
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
  if (report.status === "aborted") process.exitCode = 1;
}
