import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { semanticLog } from "./util.ts";
import { fileURLToPath } from "node:url";
import { EventLog, FakeCommands, FakeExecutor, resolveModels, RunRefused, runWorkflow } from "../src/host/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const twoNode = resolve(here, "../examples/two-node/workflow.ts");
const fanout = resolve(here, "fixtures/fanout/workflow.ts");
const tmp = () => mkdtempSync(join(tmpdir(), "wallis-host-"));
const quiet = { inboxPollMs: null, confine: "off" } as const;

const twoNodeResponses = {
	planner: { output: { outline: ["a"], note: "n" } },
	writer: { output: { text: "t", words: 1 } },
};

function fanoutExecutor() {
	return new FakeExecutor({
		scout: (call) => ({ output: { errors: [`E-${(call.input as { area: string }).area}`] } }),
		judge: {
			output: {
				findings: [
					{ content: "f1", confidence: 0.9 },
					{ content: "f2", confidence: 0.2 },
					{ content: "f3", confidence: 0.5 },
				],
			},
		},
		merger: { output: { items: [{ content: "f1+f3", confidence: 0.9 }, { content: "f2", confidence: 0.2 }], archived: [{ content: "f1", confidence: 0.9 }] } },
		attempt: [{ output: { ok: false } }, { output: { ok: true } }],
	});
}

/** A copy of a workflow file with edits, next to the original's prompts. */
function variant(source: string, edit: (text: string) => string): string {
	const dir = tmp();
	const text = edit(readFileSync(source, "utf8")).replace(/from "\.\/([\w-]+\.md)"/g, (_m, f) => `from ${JSON.stringify(resolve(source, "..", f))}`);
	writeFileSync(join(dir, "workflow.ts"), text);
	return join(dir, "workflow.ts");
}

test("runs are deterministic: same log for the same inputs and seed", async () => {
	const dir = tmp();
	const run = (name: string, seed: number) =>
		runWorkflow({ ...quiet, workflow: twoNode, dir: join(dir, name), executor: new FakeExecutor(twoNodeResponses), input: { topic: "x" }, seed });
	const a = await run("a", 3);
	const b = await run("b", 3);
	assert.equal(semanticLog(join(dir, "a", "log.jsonl")), semanticLog(join(dir, "b", "log.jsonl")));
	assert.deepEqual(a.outcome, b.outcome);
	const c = await run("c", 4);
	assert.notDeepEqual(c.outcome, a.outcome, "the seed reaches Math.random");
});

test("resume refuses a changed seed with a typed refusal; the alias table is operational", async () => {
	const dir = join(tmp(), "run");
	await runWorkflow({ ...quiet, workflow: twoNode, dir, executor: new FakeExecutor(twoNodeResponses), input: { topic: "x" }, seed: 1 });
	const before = readFileSync(join(dir, "log.jsonl"), "utf8");
	await assert.rejects(
		runWorkflow({ ...quiet, workflow: twoNode, dir, executor: new FakeExecutor(twoNodeResponses), seed: 2 }),
		(e: unknown) => e instanceof RunRefused && JSON.stringify(e.refusal) === JSON.stringify({ type: "pin_mismatch", field: "seed", recorded: "1", current: "2" }),
	);
	// A refused resume changes nothing.
	assert.equal(readFileSync(join(dir, "log.jsonl"), "utf8"), before);
	// A remapped alias is accepted and logged; the finished run executes nothing.
	const executor = new FakeExecutor(twoNodeResponses);
	const r = await runWorkflow({ ...quiet, workflow: twoNode, dir, executor, models: { writer: "other/model" } });
	assert.equal(r.outcome?.type, "done");
	assert.equal(executor.calls.length, 0);
});

test("resume refuses a changed pinned input file", async () => {
	const root = tmp();
	const workflow = variant(twoNode, (t) => t.replace('name: "two-node",', 'name: "two-node",\n\tpin: { files: ["advice.md"] },'));
	writeFileSync(join(root, "advice.md"), "v1");
	const opts = { ...quiet, workflow, dir: join(root, "run"), root, executor: new FakeExecutor(twoNodeResponses), input: { topic: "x" } };
	await runWorkflow(opts);
	writeFileSync(join(root, "advice.md"), "v2");
	await assert.rejects(runWorkflow(opts), (e: unknown) => e instanceof RunRefused && e.refusal.type === "pin_mismatch" && e.refusal.field === "inputs.advice.md");
});

test("parallel branches, a nested workflow, an explicit merge call, commands, observations; a reached compute budget holds new calls until raised", async () => {
	const dir = join(tmp(), "run");
	const executor = fanoutExecutor();
	const scripts = new FakeCommands({ train: (call) => ({ stdout: JSON.stringify({ budget: call.computeMinutes }), minutes: 5 }) });
	const first = await runWorkflow({ ...quiet, workflow: fanout, dir, executor, commands: scripts, input: null });
	assert.deepEqual(first.status, { type: "idle", reason: { type: "budget_reached", kind: "compute_minutes", spent: 5, limit: 5 } });
	assert.equal(scripts.calls.length, 1);

	const ids = executor.calls.map((c) => c.id);
	assert.deepEqual(ids, ["#0.a#0", "#0.b#0", "#1", "#2", "#3>retry#0", "#3>retry#1"]);
	// Agents get what they need in their input: the judge sees both branches' errors.
	const judge = executor.calls.find((c) => c.agent === "judge")!;
	assert.deepEqual(judge.input, { errors: ["E-a", "E-b"] });
	assert.match(judge.prompt, /E-a/);
	assert.deepEqual(executor.calls[1]!.input, { area: "b", known: [] }, "each branch got the memory as of its call");
	// Observations are logged with their position; they never shift request ids.
	assert.deepEqual(
		first.run.observations.map((o) => [o.at, o.label]),
		[["~0", "errors"], ["#3>retry~0", "attempt"], ["#3>retry~1", "attempt"]],
	);

	// Raise the budget: the paused script runs, nothing completed runs again,
	// and the body's local variables are rebuilt by the replay.
	const executor2 = fanoutExecutor();
	const r = await runWorkflow({ ...quiet, workflow: fanout, dir, executor: executor2, commands: scripts, budget: { compute_minutes: 20 } });
	assert.equal(r.outcome?.type, "done", JSON.stringify(r.status));
	assert.equal(executor2.calls.length, 0);
	assert.equal(scripts.calls.length, 2);
	const out = (r.outcome as { value: Record<string, unknown> }).value;
	assert.deepEqual(out.tries, { attempts: 2 });
	assert.deepEqual(out.trained, { budget: 5 });
	assert.deepEqual(out.again, { budget: 15 });
	assert.deepEqual(out.errors, ["E-a", "E-b"]);
	assert.deepEqual(out.findings, [{ content: "f1+f3", confidence: 0.9 }, { content: "f2", confidence: 0.2 }]);
	assert.deepEqual(out.archive, [{ content: "f1", confidence: 0.9 }]);
	const log = new EventLog(join(dir, "log.jsonl")).read();
	assert.deepEqual(log.filter((e) => e.type === "budget_raised"), [{ type: "budget_raised", kind: "compute_minutes", limit: 20 }]);
	assert.equal(log.filter((e) => e.type === "observed").length, 3, "replayed observations are not logged again");
});

test("a reached turn budget admits no new call; calls in flight finish (a small overshoot); a raise continues", async () => {
	const dir = join(tmp(), "run");
	const workflow = variant(fanout, (t) => t.replace("budget: { turns: 100, computeMinutes: 5 },", "budget: { turns: 1, computeMinutes: 5 },"));
	const executor = fanoutExecutor();
	const scripts = new FakeCommands({ train: { stdout: JSON.stringify({ budget: null }), minutes: 1 } });
	const paused = await runWorkflow({ ...quiet, workflow, dir, executor, commands: scripts, input: null });
	// Both parallel scouts were in flight: both finished, overshooting by one turn; the judge was held.
	assert.deepEqual(paused.status, { type: "idle", reason: { type: "budget_reached", kind: "turns", spent: 2, limit: 1 } });
	assert.deepEqual(executor.calls.map((c) => c.agent), ["scout", "scout"]);
	assert.ok(paused.run.spent.usd > 0, "USD is recorded, never budgeted");
	const again = fanoutExecutor();
	const r = await runWorkflow({ ...quiet, workflow, dir, executor: again, commands: scripts, budget: { turns: 50 } });
	assert.equal(r.outcome?.type, "done", JSON.stringify(r.status));
	assert.equal(again.calls[0]!.agent, "judge");
});

test("model aliases resolve call-time > workflow profile > global profile > workflow > default", () => {
	const table = { default: "p/d", judge: "", fast: "p/f" };
	assert.deepEqual(resolveModels("w", table), { default: "p/d", fast: "p/f", judge: "p/d" });
	assert.deepEqual(
		resolveModels("w", table, { callTime: { judge: "c/j" }, profile: { global: { judge: "g/j", fast: "g/f" }, workflows: { w: { judge: "w/j" } } } }),
		{ default: "p/d", fast: "g/f", judge: "c/j" },
	);
	assert.throws(() => resolveModels("w", table, { callTime: { extra: "x/y" } }), /unknown model alias extra/);
	assert.throws(() => resolveModels("w", { default: "" }), /default is unresolved/);
});


test("call-time mounts are noted and reused by every later host; a host whose boot is refused refuses the inbox entries waiting for it", async () => {
	const { appendInbox, runPaths } = await import("../src/host/store.ts");
	const { refusedEntry } = await import("../src/host/store.ts");
	const workflow = resolve(here, "fixtures/mounted/workflow.ts");
	const data = tmp();
	const dir = join(tmp(), "run");
	const first = await runWorkflow({ ...quiet, workflow, dir, executor: new FakeExecutor({}), input: null, mounts: { data } });
	assert.equal(first.run.nodes[0]?.type, "orchestrator_pending");
	// A later host, without --mount (as a resume or the detached host of `submit` is): no mount_unset.
	appendInbox(runPaths(dir), { id: "s1", type: "submit", node: "#0", value: { ok: true }, by: "human" });
	const done = await runWorkflow({ ...quiet, workflow, dir, executor: new FakeExecutor({}) });
	assert.deepEqual(done.outcome, { type: "done", value: { ok: true } });
	// A host whose boot is refused (here: another seed) answers what waits for it.
	const second = join(tmp(), "run");
	await runWorkflow({ ...quiet, workflow, dir: second, executor: new FakeExecutor({}), input: null, mounts: { data }, seed: 1 });
	appendInbox(runPaths(second), { id: "s2", type: "submit", node: "#0", value: { ok: true }, by: "human" });
	await assert.rejects(runWorkflow({ ...quiet, workflow, dir: second, executor: new FakeExecutor({}), seed: 2 }), (e: unknown) => e instanceof RunRefused);
	assert.equal(refusedEntry(runPaths(second), "s2")?.type, "pin_mismatch");
});
