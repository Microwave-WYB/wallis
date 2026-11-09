// The journal is a content-addressed cache: (node definition digest,
// canonical input, occurrence). A resume re-executes the body against it:
// unchanged calls hit, changed ones miss and run, downstream calls miss when
// their inputs change. Also concurrency: deterministic ids for plain
// Promise.all, branch counters for multi-step branches.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type AgentCall, EventLog, FakeExecutor, forkRun, runWorkflow } from "../src/host/index.ts";
import { tmp } from "./util.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const twoNode = resolve(here, "../examples/two-node/workflow.ts");
const fanout = resolve(here, "fixtures/fanout/workflow.ts");
const concurrent = resolve(here, "fixtures/concurrent/workflow.ts");
const quiet = { inboxPollMs: null, confine: "off" } as const;

/** A copy of a workflow file with edits, next to the original's prompts. */
function variant(source: string, edit: (text: string) => string): string {
	const dir = tmp();
	const text = edit(readFileSync(source, "utf8")).replace(/from "\.\/([\w-]+\.md)"/g, (_m, f) => `from ${JSON.stringify(resolve(source, "..", f))}`);
	assert.notEqual(text, readFileSync(source, "utf8").replace(/from "\.\/([\w-]+\.md)"/g, (_m, f) => `from ${JSON.stringify(resolve(source, "..", f))}`), "the edit applied");
	writeFileSync(join(dir, "workflow.ts"), text);
	return join(dir, "workflow.ts");
}

const responses = (outline = ["a"]) => ({
	planner: { output: { outline, note: "n" } },
	writer: { output: { text: "t", words: 1 } },
});

/** A finished two-node run, and a fork of it (the whole cache) to resume with other code. */
async function finishedThenFork() {
	const root = tmp();
	const dir = join(root, "run");
	const first = await runWorkflow({ ...quiet, workflow: twoNode, dir, executor: new FakeExecutor(responses()), input: { topic: "x" }, seed: 3 });
	assert.equal(first.outcome?.type, "done");
	const fork = forkRun(dir, join(root, "fork")).dir;
	return { first, fork };
}

test("a crash resume (here: a fork) gives all hits", async () => {
	const { first, fork } = await finishedThenFork();
	const executor = new FakeExecutor({});
	const r = await runWorkflow({ ...quiet, workflow: twoNode, dir: fork, executor });
	assert.equal(executor.calls.length, 0);
	assert.deepEqual(r.outcome, first.outcome);
});

test("a change in later logic: the earlier calls hit; the code change is logged with both digests", async () => {
	const { fork } = await finishedThenFork();
	const workflow = variant(twoNode, (t) => t.replace("roll: Math.random() }", "roll: 0 }"));
	const executor = new FakeExecutor({});
	const r = await runWorkflow({ ...quiet, workflow, dir: fork, executor });
	assert.equal(executor.calls.length, 0);
	assert.equal((r.outcome as unknown as { value: { roll: number } }).value.roll, 0);
	const changed = new EventLog(join(fork, "log.jsonl")).read().filter((e) => e.type === "code_changed");
	assert.equal(changed.length, 1);
	assert.equal(r.run.code.length, 2, "the pin records both digests");
});

test("a changed prompt misses; downstream misses when its input changes, hits when it does not", async () => {
	const { fork } = await finishedThenFork();
	const workflow = variant(twoNode, (t) => t.replace("prompt: plannerPrompt,", 'prompt: "Plan briefly.",'));
	// Same outline from the new prompt: the writer's input is unchanged, so it hits.
	const same = new FakeExecutor(responses());
	await runWorkflow({ ...quiet, workflow, dir: fork, executor: same });
	assert.deepEqual(same.calls.map((c) => c.agent), ["planner"]);
	// Another outline: the writer's input changed, so it misses too.
	const { fork: fork2 } = await finishedThenFork();
	const other = new FakeExecutor(responses(["b"]));
	await runWorkflow({ ...quiet, workflow, dir: fork2, executor: other });
	assert.deepEqual(other.calls.map((c) => c.agent), ["planner", "writer"]);
});

test("an inserted node runs; its neighbours still hit under their new ids", async () => {
	const { fork } = await finishedThenFork();
	const workflow = variant(twoNode, (t) => t.replace("const plan = await ctx.session(planner).call({ topic: input.topic });", 'await ctx.session(planner).call({ topic: "warm-up" });\n\t\tconst plan = await ctx.session(planner).call({ topic: input.topic });'));
	const executor = new FakeExecutor(responses());
	const r = await runWorkflow({ ...quiet, workflow, dir: fork, executor });
	assert.deepEqual(executor.calls.map((c) => [c.id, (c.input as { topic?: string }).topic]), [["#0:0", "warm-up"]]);
	assert.equal(r.outcome?.type, "done");
});

test("reordering two parallel branches still hits", async () => {
	const root = tmp();
	const dir = join(root, "run");
	const exec = () =>
		new FakeExecutor({
			scout: (call) => ({ output: { errors: [`E-${(call.input as { area: string }).area}`] } }),
			judge: { output: { findings: [] } },
			merger: { output: { items: [], archived: [] } },
			attempt: { output: { ok: true } },
		});
	const { FakeCommands } = await import("../src/host/index.ts");
	const commands = () => new FakeCommands({ train: { stdout: JSON.stringify({ budget: null }) } });
	await runWorkflow({ ...quiet, workflow: fanout, dir, executor: exec(), commands: commands(), input: null });
	const fork = forkRun(dir, join(root, "fork")).dir;
	const workflow = variant(fanout, (t) =>
		t.replace(
			'a: (c) => c.session(scout).call({ area: "a", known: errors }),\n\t\t\tb: (c) => c.session(scout).call({ area: "b", known: errors }),',
			'b: (c) => c.session(scout).call({ area: "b", known: errors }),\n\t\t\ta: (c) => c.session(scout).call({ area: "a", known: errors }),',
		),
	);
	const again = exec();
	const r = await runWorkflow({ ...quiet, workflow, dir: fork, executor: again, commands: commands() });
	assert.equal(again.calls.length, 0);
	assert.equal(r.outcome?.type, "done");
});

/** Answers each call with its own id, after a delay that depends on `order`, so results arrive in that order. */
function echoes(order: "forward" | "reverse") {
	return new FakeExecutor({
		echo: async (call: AgentCall) => {
			const n = (call.input as { n: number }).n;
			await new Promise((r) => setTimeout(r, order === "forward" ? n : 100 - n));
			return { output: { n, by: call.id } };
		},
	});
}

test("Promise.all and ctx.map are deterministic whatever order results arrive in; identical calls get their own results", async () => {
	const root = tmp();
	const a = await runWorkflow({ ...quiet, workflow: concurrent, dir: join(root, "a"), executor: echoes("forward"), input: null });
	const b = await runWorkflow({ ...quiet, workflow: concurrent, dir: join(root, "b"), executor: echoes("reverse"), input: null });
	assert.deepEqual(a.outcome, b.outcome);
	const out = (a.outcome as unknown as { value: { a: string; b: string; c: string; steps: string[][] } }).value;
	// Ids are taken at invocation: #0, #1, #2; each map branch has its own counter.
	assert.deepEqual(out, { a: "#0:0", b: "#1:0", c: "#2:0", steps: [["#3.0#0:0", "#3.0#1:0"], ["#3.1#0:0", "#3.1#1:0"]] });

	// Killed after a few results; resumed with results arriving in the other order: the same outcome, and no completed call runs again.
	const log = new EventLog(join(root, "a", "log.jsonl")).read();
	const third = log.map((e, i) => [e.type, i] as const).filter(([t]) => t === "agent_returned")[2]![1];
	const cut = join(root, "cut");
	mkdirSync(cut);
	writeFileSync(join(cut, "log.jsonl"), log.slice(0, third + 1).map((e) => `${JSON.stringify(e)}\n`).join(""));
	const resumed = echoes("reverse");
	const r = await runWorkflow({ ...quiet, workflow: concurrent, dir: cut, executor: resumed });
	assert.deepEqual(r.outcome, a.outcome);
	assert.equal(resumed.calls.length, 7 - 3);
});
