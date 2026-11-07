// Schema checks at the boundary: typed command outputs (A), agent outputs
// parsed before anything is logged (B), and the model fixing its own output
// inside its loop (C).

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Conversation, conversation, EventLog, type Executor, FakeCommands, FakeExecutor, runWorkflow, type Turn } from "../src/host/index.ts";
import { tmp } from "./util.ts";

const workflow = resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures/boundary/workflow.ts");

async function run(mode: string, options: { tagger?: Turn; strict?: Turn | Conversation; reporter?: Turn; score?: unknown } = {}) {
	const dir = join(tmp(), "run");
	const executor = new FakeExecutor({
		tagger: options.tagger ?? { submit: { tags: ["ok"] } },
		strict: options.strict ?? { submit: { answer: 1 } },
		reporter: options.reporter ?? { submit: { report: { digest: `sha256:${"0".repeat(64)}`, name: "r.md", media: "text/markdown" } } },
	});
	const commands = new FakeCommands({ measure: { stdout: JSON.stringify({ score: options.score ?? 0.5 }), minutes: 1 } });
	const result = await runWorkflow({ workflow, dir, executor, commands, confine: "off", input: { mode }, inboxPollMs: null });
	return { result, executor, commands, dir, log: new EventLog(join(dir, "log.jsonl")).read(), value: (result.outcome as { value?: unknown } | null)?.value };
}

// --- A. Typed commands ---

test("a command's output is checked against its schema before it is logged, typed", async () => {
	const ok = await run("command");
	assert.deepEqual(ok.value, { score: 0.5 });
	assert.deepEqual(ok.commands.calls[0]!.argv, ["sh", "-c", "cat"]);
	assert.deepEqual(ok.commands.calls[0]!.input, { n: 1 });

	const bad = await run("command", { score: "high" });
	assert.equal((bad.value as { error: string }).error, "CommandFailed");
	assert.equal((bad.value as { failure: string }).failure, "output_mismatch");
	const failed = bad.log.find((e) => e.type === "command_failed");
	assert.ok(failed, "logged as a command failure");
	assert.ok(!bad.log.some((e) => e.type === "command_returned"), "the bad output is never logged as a result");
});

test("a command's input is checked in the sandbox: a typed error and nothing logged", async () => {
	const r = await run("command_bad_input");
	assert.deepEqual(r.value, { error: "SchemaError", subject: "input of command measure" });
	assert.equal(r.commands.calls.length, 0);
	assert.ok(!r.log.some((e) => e.type === "requested"));
});

// --- B. Agent outputs ---

test("an agent output that does not match its schema fails the call; nothing is logged as a result", async () => {
	// An executor that skips its own submit_result check: the host parses the output anyway.
	const dir = join(tmp(), "run");
	const executor: Executor = { id: "lax", start: () => ({ turn: async () => ({ type: "submitted", output: { tags: ["much too long"] } }), handle: () => null, close: () => {} }) };
	const result = await runWorkflow({ workflow, dir, executor, confine: "off", input: { mode: "agent" }, inboxPollMs: null });
	const r = { value: (result.outcome as { value?: unknown }).value, log: new EventLog(join(dir, "log.jsonl")).read() };
	assert.equal((r.value as { error: string }).error, "AgentFailed");
	assert.match((r.value as { message: string }).message, /output does not match its schema/);
	assert.ok(r.log.some((e) => e.type === "agent_failed"));
	assert.ok(!r.log.some((e) => e.type === "agent_returned"));
	const ok = await run("agent");
	assert.deepEqual(ok.value, { tags: ["ok"] });
});

test("an artifact ref in an output is verified against the run's store", async () => {
	const r = await run("report");
	assert.deepEqual(r.value, { error: "AgentFailed", agent: "reporter", failure: "gave_up", message: `artifact r.md (sha256:${"0".repeat(64)}) is not in the run's store` });
	assert.ok(!r.log.some((e) => e.type === "agent_returned"));
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
	assert.deepEqual(returned, [{ type: "agent_returned", id: "#0", output: { answer: 2 }, usage: { usd: 0.03, tokens: 300, turns: 3 }, model: "fake/default" }]);
	assert.ok(!JSON.stringify(r.log).includes('"two"'));
	// Replay is identical: a second run gives the same log, a resume executes nothing.
	const again = await run("submit", { strict });
	assert.deepEqual(again.log, r.log);
	const executor = new FakeExecutor({});
	const resumed = await runWorkflow({ workflow, dir: r.dir, executor, confine: "off", inboxPollMs: null });
	assert.equal(resumed.snapshot, r.result.snapshot);
	assert.equal(executor.calls.length, 0);
});

test("never submitting a valid result is an agent failure", async () => {
	const gaveUp = await run("submit", { strict: { submits: [{ answer: 0 }, { answer: -1 }] } });
	assert.deepEqual(gaveUp.value, { error: "AgentFailed", agent: "strict", failure: "gave_up", message: "gave up: no submit_result passed validation" });
});

test("reaching maxTurns idles the node (turn_limit); more turns continue it; replay is identical", async () => {
	const strict = conversation({ submits: [{ answer: 0 }, { answer: 0 }, { answer: 0 }, { answer: 0 }, { answer: 5 }] }, { submit: { answer: 5 } });
	const first = await run("submit", { strict });
	assert.deepEqual(first.result.status, { type: "idle", reason: null });
	const node = first.result.run.nodes[0]!;
	assert.deepEqual(node.type === "node_idle" && node.cause, { type: "turn_limit", used: 4, limit: 4 });
	assert.ok(first.log.some((e) => e.type === "turn_limit_reached"));
	// An answer without turns is refused; with turns it continues the same node.
	await assert.rejects(runWorkflow({ workflow, dir: first.dir, executor: new FakeExecutor({ strict }), confine: "off", sends: [{ node: "#0", text: "go on" }], inboxPollMs: null }), /no_turns_left/);
	const executor = new FakeExecutor({ strict });
	const done = await runWorkflow({ workflow, dir: first.dir, executor, confine: "off", sends: [{ node: "#0", text: "Continue.", turns: 3 }], inboxPollMs: null });
	assert.deepEqual(done.outcome, { type: "done", value: { answer: 5 } });
	assert.deepEqual(executor.calls.map((c) => [c.turn, c.turnLimit]), [[4, 7]]);
	// A resume replays from the journal: the same snapshot, nothing called.
	const again = new FakeExecutor({});
	const replayed = await runWorkflow({ workflow, dir: first.dir, executor: again, confine: "off", inboxPollMs: null });
	assert.equal(replayed.snapshot, done.snapshot);
	assert.equal(again.calls.length, 0);
});
