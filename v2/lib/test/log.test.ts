// The append-only log: complete lines only, and a line a crash cut short
// is cut off before the next append.

import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EventLog } from "../src/host/log.ts";
import { tmp } from "./util.ts";

test("a truncated last line is dropped on read and repaired by the next append", () => {
	const path = join(tmp(), "log.jsonl");
	const log = new EventLog(path);
	log.append({ type: "body_finished", output: 1 });
	appendFileSync(path, '{"type":"noted","key":"k","va');
	assert.equal(log.read().length, 1);
	log.append({ type: "noted", key: "a", value: 2 });
	assert.deepEqual(log.read().map((e) => e.type), ["body_finished", "noted"]);
	assert.equal(readFileSync(path, "utf8").split("\n").length, 3);
});

test("a line that is not an event is an error, not skipped", () => {
	const path = join(tmp(), "log.jsonl");
	writeFileSync(path, "[1,2]\n");
	assert.throws(() => new EventLog(path).read(), /not an event/);
	assert.deepEqual(new EventLog(join(tmp(), "none.jsonl")).read(), []);
});
