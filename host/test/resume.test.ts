// Kill the two-node example mid-run, resume it, and compare with an
// uninterrupted run: same final state, same log, no completed call re-executed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { semanticLog } from "./util.ts";
import { fileURLToPath } from "node:url";

const runner = resolve(fileURLToPath(import.meta.url), "../../examples/two-node/run.ts");

function run(args: string[]) {
	return spawnSync(process.execPath, [runner, ...args], { encoding: "utf8" });
}

function lines(path: string): unknown[] {
	return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("a killed run resumes to the same state and log as an uninterrupted run", () => {
	const dir = mkdtempSync(join(tmpdir(), "wallis-resume-"));

	const whole = run(["--dir", join(dir, "whole")]);
	assert.equal(whole.status, 0, whole.stderr);
	const expected = JSON.parse(whole.stdout);
	assert.equal(expected.outcome.type, "done");

	// Killed while the writer call is in flight.
	const killedDir = join(dir, "killed");
	const killedLog = join(killedDir, "log.jsonl");
	const killed = run(["--dir", killedDir, "--exec-log", join(dir, "exec-killed.jsonl"), "--kill-on", "writer"]);
	assert.equal(killed.signal, "SIGKILL");
	const atKill = lines(killedLog) as { type: string; id?: string }[];
	assert.ok(atKill.some((e) => e.type === "agent_returned" && e.id === "#0:0"), "planner completed before the kill");
	assert.ok(!atKill.some((e) => e.type === "agent_returned" && e.id === "#1:0"), "writer was in flight");

	const resumed = run(["--dir", killedDir, "--exec-log", join(dir, "exec-resumed.jsonl")]);
	assert.equal(resumed.status, 0, resumed.stderr);
	const result = JSON.parse(resumed.stdout);
	assert.equal(result.resumed, true);

	assert.deepEqual(result.outcome, expected.outcome);
	assert.equal(result.snapshot, expected.snapshot);
	assert.equal(semanticLog(killedLog), semanticLog(join(dir, "whole", "log.jsonl")));

	// The completed planner call was answered from the journal, not re-executed.
	assert.deepEqual(lines(join(dir, "exec-killed.jsonl")), [
		{ id: "#0:0", agent: "planner" },
		{ id: "#1:0", agent: "writer" },
	]);
	assert.deepEqual(lines(join(dir, "exec-resumed.jsonl")), [{ id: "#1:0", agent: "writer" }]);
});

test("resuming a finished run reports its outcome without executing anything", () => {
	const dir = mkdtempSync(join(tmpdir(), "wallis-resume-"));
	const log = join(dir, "run");
	const first = run(["--dir", log]);
	assert.equal(first.status, 0, first.stderr);
	const again = run(["--dir", log, "--exec-log", join(dir, "exec.jsonl")]);
	assert.equal(again.status, 0, again.stderr);
	assert.deepEqual(JSON.parse(again.stdout).outcome, JSON.parse(first.stdout).outcome);
	assert.throws(() => readFileSync(join(dir, "exec.jsonl")));
});
