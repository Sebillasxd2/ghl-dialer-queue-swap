import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: root });

test("a bad --now, --cap or --cool-off-days stops the run instead of dropping a filter", () => {
  assert.equal(run("plan").status, 0);
  for (const [flag, value] of [["--now", "not-a-date"], ["--cap", "abc"], ["--cool-off-days", "soon"]] as const) {
    const result = run("plan", flag, value);
    assert.equal(result.status, 2, `${flag} ${value}`);
    assert.match(result.stderr, new RegExp(flag));
  }
});

test("an unknown flag is a usage error, not a stack trace", () => {
  const result = run("plan", "--colloff-days", "3");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test("the live swap refuses to run without --live, a rep and credentials", () => {
  const result = run("swap", "--rep", "rep_demo_01");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--reps with your own rep records/);
});
