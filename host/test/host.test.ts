import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EventLog, FakeExecutor, FakeScripts, resolveModels, RunRefused, runWorkflow } from "../src/host/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const twoNode = resolve(here, "../examples/two-node/workflow.ts");
const fanout = resolve(here, "fixtures/fanout/workflow.ts");
const tmp = () => mkdtempSync(join(tmpdir(), "wallis-host-"));
const quiet = { inboxPollMs: null } as const;

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
	assert.equal(readFileSync(join(dir, "a", "log.jsonl"), "utf8"), readFileSync(join(dir, "b", "log.jsonl"), "utf8"));
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

test("parallel branches, a sub-workflow, llmMerge, typed scripts; a spent compute budget pauses until raised", async () => {
	const dir = join(tmp(), "run");
	const executor = fanoutExecutor();
	const scripts = new FakeScripts({ train: (call) => ({ output: { budget: call.computeMinutes }, minutes: 5 }) });
	const first = await runWorkflow({ ...quiet, workflow: fanout, dir, executor, scripts, input: null });
	assert.deepEqual(first.status, { type: "idle", reason: { type: "budget_exhausted", kind: "compute_minutes", spent: 5, limit: 5 } });
	assert.equal(scripts.calls.length, 1);

	const ids = executor.calls.map((c) => c.id);
	assert.deepEqual(ids, ["#0.a#0", "#0.b#0", "#1", "#1/merge/findings", "#2>retry#0", "#2>retry#1"]);
	const judge = executor.calls.find((c) => c.agent === "judge")!;
	assert.match(judge.view, /E-a/);
	assert.match(judge.view, /E-b/);
	assert.doesNotMatch(judge.view, /confidence/);
	assert.doesNotMatch(executor.calls[1]!.view, /E-a/, "each branch saw the state as of its own request");

	// Raise the budget: the paused script runs, nothing completed runs again.
	const executor2 = fanoutExecutor();
	const r = await runWorkflow({ ...quiet, workflow: fanout, dir, executor: executor2, scripts, budget: { compute_minutes: 20 } });
	assert.equal(r.outcome?.type, "done", JSON.stringify(r.status));
	assert.equal(executor2.calls.length, 0);
	assert.equal(scripts.calls.length, 2);
	const out = (r.outcome as { value: Record<string, unknown> }).value;
	assert.deepEqual(out.tries, { attempts: 2 });
	assert.deepEqual(out.trained, { budget: 5 });
	assert.deepEqual(out.again, { budget: 15 });
	assert.deepEqual(out.findings, [{ content: "f1+f3", confidence: 0.9 }, { content: "f2", confidence: 0.2 }]);
	assert.deepEqual(out.archive, [{ content: "f1", confidence: 0.9 }]);
	assert.deepEqual(r.run.state.errors, ["E-a", "E-b"]);
	const log = new EventLog(join(dir, "log.jsonl")).read();
	assert.deepEqual(log.filter((e) => e.type === "budget_raised"), [{ type: "budget_raised", kind: "compute_minutes", limit: 20 }]);
});

test("a non-commutative write in a parallel branch is refused into the body, typed", async () => {
	const workflow = variant(fanout, (t) =>
		t
			.replace('writes: { errors: "errors" }', 'writes: { log: "errors" }')
			.replace('log: append(Type.String()),', "log: append(Type.Array(Type.String())),")
			.replace(
				/run: async \(ctx\) => \{[\s\S]*\n\t\},\n\}\);\n$/,
				'run: async (ctx) => {\n\t\ttry { await ctx.parallel({ a: (c) => c.call(scout, { area: "a" }) }); return "accepted"; } catch (e) { return (e as Refused).refusal; }\n\t},\n});\n',
			)
			.replace("import { append,", "import { type Refused, append,"),
	);
	const r = await runWorkflow({ ...quiet, workflow, dir: join(tmp(), "run"), executor: fanoutExecutor(), input: null });
	assert.deepEqual(r.outcome, { type: "done", value: { type: "non_commutative_write_in_branch", field: "log", branch: "#0.a" } });
});

test("a spent USD budget pauses before the next call; a raise continues it", async () => {
	const dir = join(tmp(), "run");
	const workflow = variant(twoNode, (t) => t.replace('name: "two-node",', 'name: "two-node",\n\tbudget: { usd: 1 },'));
	const responses = { ...twoNodeResponses, planner: { submit: { outline: ["a"], note: "n" }, usage: { usd: 5, tokens: 1, turns: 1 } } };
	const executor = new FakeExecutor(responses);
	const paused = await runWorkflow({ ...quiet, workflow, dir, executor, input: { topic: "x" } });
	assert.deepEqual(paused.status, { type: "idle", reason: { type: "budget_exhausted", kind: "usd", spent: 5, limit: 1 } });
	assert.equal(paused.outcome, null);
	assert.equal(executor.calls.length, 1);
	const again = new FakeExecutor(responses);
	const r = await runWorkflow({ ...quiet, workflow, dir, executor: again, budget: { usd: 10 } });
	assert.equal(r.outcome?.type, "done");
	assert.deepEqual(again.calls.map((c) => c.agent), ["writer"]);
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

