// The journal: the core and its log driven together, as a process does.
// A crash is a new Journal on the same log; the body requests again.

import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Event, SEMANTICS } from "../src/host/core.ts";
import { DifferentialMismatch, Journal } from "../src/host/journal.ts";
import { tmp } from "./util.ts";

const started: Event = { type: "started", workflow: { name: "w", digest: "d1" }, input: null, semantics: SEMANTICS };
const resumed: Event = { type: "resumed", digest: "d1", semantics: SEMANTICS };
const call = (id: string, input: number, occurrence = 0): Event => ({ type: "requested", id, request: { type: "command_call", name: "c", input }, node: "n1", scope: "", occurrence });

test("only checkpointed events reach the log; effects come back without the checkpoint", () => {
	const j = Journal.open(join(tmp(), "log.jsonl"));
	assert.deepEqual(j.step(started), []);
	assert.deepEqual(j.step(call("0", 1)), [{ type: "run_command", id: "0", attempt: 1 }]);
	assert.deepEqual(j.step({ type: "command_returned", id: "0", output: { x: 1 } }), [{ type: "deliver", id: "0", value: { x: 1 } }]);
	assert.equal(j.log.read().length, 3);
});

test("a new process resumes from the log: completed calls hit, the one in flight is issued again", () => {
	const path = join(tmp(), "log.jsonl");
	const first = Journal.open(path);
	first.step(started);
	first.step(call("0", 1));
	first.step({ type: "command_returned", id: "0", output: 1 });
	first.step(call("1", 2));
	// The process dies here.
	const second = Journal.open(path);
	second.step(resumed);
	assert.deepEqual(second.step(call("0", 1)), [{ type: "deliver", id: "0", value: 1 }]);
	assert.deepEqual(second.step(call("1", 2)), [{ type: "run_command", id: "1", attempt: 1 }]);
	// Hits and the reissue are not logged: only the resume is.
	assert.deepEqual(new Set(second.log.read().map((e) => e.type)), new Set(["started", "requested", "command_returned", "resumed"]));
	assert.equal(second.log.read().length, 5);
});

test("the differential check throws when the log and the live state differ", () => {
	const path = join(tmp(), "log.jsonl");
	const j = Journal.open(path);
	j.step(started);
	// Someone else's line in the log: the rebuilt state now differs.
	appendFileSync(path, `${JSON.stringify(call("9", 9))}\n`);
	assert.throws(() => j.step(call("0", 1)), DifferentialMismatch);
	assert.match(readFileSync(path, "utf8"), /"9"/);
});
