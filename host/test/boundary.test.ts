// Schema checks at the boundary: typed script outputs (A), every state
// write (B), and the model fixing its own output inside its loop (C).

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EventLog, FakeExecutor, FakeScripts, runWorkflow, type Turn } from "../src/host/index.ts";
import { tmp } from "./util.ts";

const workflow = resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures/boundary/workflow.ts");

async function run(mode: string, options: { tagger?: Turn; strict?: Turn; score?: unknown } = {}) {
	const dir = join(tmp(), "run");
	const executor = new FakeExecutor({
		tagger: options.tagger ?? { submit: { tags: ["ok"] } },
		strict: options.strict ?? { submit: { answer: 1 } },
	});
	const scripts = new FakeScripts({ measure: { output: { score: options.score ?? 0.5 } as never, minutes: 1 } });
	const result = await runWorkflow({ workflow, dir, executor, scripts, input: { mode }, inboxPollMs: null });
	return { result, executor, scripts, dir, log: new EventLog(join(dir, "log.jsonl")).read(), value: (result.outcome as { value?: unknown }).value };
}

// --- A. Typed scripts ---

test("a script's output is checked against its schema before it is logged", async () => {
	const ok = await run("script");
	assert.deepEqual(ok.value, { score: 0.5 });
	assert.deepEqual(ok.scripts.calls[0]!.outputSchema, { type: "object", required: ["score"], properties: { score: { type: "number" } } });

	const bad = await run("script", { score: "high" });
	assert.equal((bad.value as { error: string }).error, "ScriptFailed");
	assert.match((bad.value as { message: string }).message, /output does not match its schema/);
	const failed = bad.log.find((e) => e.type === "script_failed");
	assert.ok(failed, "logged as a script failure");
	assert.ok(!bad.log.some((e) => e.type === "script_returned"), "the bad output is never logged as a result");
});

test("script args are checked in the sandbox: a typed error and nothing logged", async () => {
	const r = await run("script_bad_args");
	assert.deepEqual(r.value, { error: "SchemaError", subject: "args of script measure" });
	assert.equal(r.scripts.calls.length, 0);
	assert.ok(!r.log.some((e) => e.type === "requested"));
});

// --- B. State writes ---

test("a body write that does not match its field throws a typed error and commits nothing", async () => {
	const r = await run("emit_bad");
	assert.deepEqual(r.value, { error: "SchemaError", subject: "write to state field scores" });
	assert.deepEqual(r.result.run.state.scores, []);
	assert.ok(!r.log.some((e) => e.type === "requested"));
});

test("an executor emit that does not match its field fails the call: nothing is committed", async () => {
	const r = await run("agent", { tagger: { submit: { tags: ["ok"] }, emits: [{ field: "scores", value: "high" }] } });
	assert.equal((r.value as { error: string }).error, "AgentFailed");
	assert.match((r.value as { message: string }).message, /emit to state field scores does not match its schema/);
	assert.deepEqual(r.result.run.state.scores, []);
	assert.deepEqual(r.result.run.state.tags, []);
	assert.ok(r.log.some((e) => e.type === "agent_failed"));
});

test("a declared write mapping is checked against its field too", async () => {
	const r = await run("agent", { tagger: { submit: { tags: ["much too long"] } } });
	assert.match((r.value as { message: string }).message, /write to state field tags does not match its schema/);
	assert.deepEqual(r.result.run.state.tags, []);
	const ok = await run("agent", { tagger: { submit: { tags: ["ok"] }, emits: [{ field: "scores", value: 3 }] } });
	assert.deepEqual(ok.result.run.state, { scores: [3], tags: ["ok"] });
});

// --- C. The model fixes its output inside its own loop ---

test("an invalid submit_result goes back to the model; the node completes on a valid one", async () => {
	const strict: Turn = { submits: [{ answer: 0 }, { answer: "two" }, { answer: 2 }] };
	const r = await run("submit", { strict });
	assert.deepEqual(r.value, { answer: 2 });
	// The executor got the output schema, and the model saw two rejections.
	assert.deepEqual(r.executor.calls[0]!.outputSchema, { type: "object", required: ["answer"], properties: { answer: { type: "integer", minimum: 1 } } });
	assert.deepEqual(r.executor.submissions.map((s) => s.errors.length > 0), [true, true, false]);
	// The log keeps only the final, valid output, with the whole call's usage.
	const returned = r.log.filter((e) => e.type === "agent_returned");
	assert.deepEqual(returned, [{ type: "agent_returned", id: "#0", output: { answer: 2 }, emits: [], usage: { usd: 0.03, tokens: 300, turns: 3 }, model: "fake/default" }]);
	assert.ok(!JSON.stringify(r.log).includes('"two"'));
	// Replay is identical: a second run gives the same log, a resume executes nothing.
	const again = await run("submit", { strict });
	assert.deepEqual(again.log, r.log);
	const executor = new FakeExecutor({});
	const resumed = await runWorkflow({ workflow, dir: r.dir, executor, inboxPollMs: null });
	assert.equal(resumed.snapshot, r.result.snapshot);
	assert.equal(executor.calls.length, 0);
});

test("never submitting a valid result, or running out of turns, is an agent failure", async () => {
	const gaveUp = await run("submit", { strict: { submits: [{ answer: 0 }, { answer: -1 }] } });
	assert.deepEqual(gaveUp.value, { error: "AgentFailed", agent: "strict", message: "gave up: no submit_result passed validation" });
	const turns = await run("submit", { strict: { submits: [{ answer: 0 }, { answer: 0 }, { answer: 0 }, { answer: 0 }, { answer: 5 }] } });
	assert.deepEqual(turns.value, { error: "AgentFailed", agent: "strict", message: "maxTurns exceeded (4)" });
	assert.deepEqual(turns.result.run.nodes[0]!.status, { type: "node_done", outcome: { type: "gave_up", error: "maxTurns exceeded (4)" } });
});
