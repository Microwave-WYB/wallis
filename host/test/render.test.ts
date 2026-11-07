// Large inputs: fields render in full unless Foldable and over maxChars;
// the window check refuses a call whose rendered input cannot fit, typed and
// journaled.

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Foldable, Type } from "../src/sdk/index.ts";
import { EventLog, FakeExecutor, renderInput, runWorkflow, windowCheck } from "../src/host/index.ts";
import { tmp } from "./util.ts";

const workflow = resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures/pi/workflow.ts");

test("fields render in full; a Foldable field over maxChars renders as a deterministic, bounded skeleton", () => {
	const schema = Type.Object({ topic: Type.String(), notes: Foldable(Type.Array(Type.Object({ text: Type.String() })), { maxChars: 50 }), long: Type.String() });
	const notes = Array.from({ length: 500 }, (_, i) => ({ text: `${"n".repeat(300)} ${i}` }));
	const long = "l".repeat(5000);
	const a = renderInput(schema, { topic: "t", notes, long });
	const b = renderInput(schema, { topic: "t", notes, long });
	assert.equal(a.text, b.text, "deterministic");
	assert.ok(a.text.includes(long), "an unmarked field renders in full");
	assert.deepEqual(a.folded, [{ path: "/notes", chars: JSON.stringify(notes).length }]);
	assert.match(a.text, /"folded": "array",\n\s+"items": 500/);
	assert.match(a.text, /"head": "n{200}"/);
	assert.ok(a.text.length < long.length + 1500, "the skeleton is size-bounded");
	// Under maxChars it renders in full.
	const small = renderInput(schema, { topic: "t", notes: [{ text: "x" }], long: "" });
	assert.deepEqual(small.folded, []);
	assert.match(small.text, /"text": "x"/);
	// The window check names the largest top-level field.
	assert.deepEqual(windowCheck(0, a, 1000), { field: "long", chars: a.text.length, limit: 3000 });
	assert.equal(windowCheck(0, small, 1000), null);
	assert.equal(windowCheck(0, a, undefined), null);
});

test("an input over the model's window is refused as input_too_large, journaled, never sent to the executor", async () => {
	const dir = join(tmp(), "run");
	const executor = new FakeExecutor({ reader: { submit: { summary: "s" } } }, { contextWindow: 100 });
	const r = await runWorkflow({ workflow, dir, executor, input: { topic: "t".repeat(1000), notes: [] }, inboxPollMs: null });
	assert.equal(r.outcome?.type, "failed");
	const reason = (r.outcome as { reason: { message: string } }).reason;
	assert.match(reason.message, /Refused: refused: input_too_large/);
	assert.equal(executor.calls.length, 0);
	const log = new EventLog(join(dir, "log.jsonl")).read();
	const rejected = log.find((e) => e.type === "input_rejected");
	assert.ok(rejected && rejected.type === "input_rejected" && rejected.field === "topic" && rejected.limit === 300);
	assert.deepEqual(r.run.nodes, [], "never a node");
});
