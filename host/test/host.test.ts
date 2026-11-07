import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeExecutor, FakeScripts, resolveModels, RunRefused, runWorkflow } from "../src/host/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const twoNode = resolve(here, "../examples/two-node/workflow.ts");
const fanout = resolve(here, "fixtures/fanout/workflow.ts");
const tmp = () => mkdtempSync(join(tmpdir(), "wallis-host-"));

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

test("runs are deterministic: same log for the same inputs and seed", async () => {
	const dir = tmp();
	const a = await runWorkflow({ workflow: twoNode, log: join(dir, "a.jsonl"), executor: new FakeExecutor(twoNodeResponses), input: { topic: "x" }, seed: 3 });
	const b = await runWorkflow({ workflow: twoNode, log: join(dir, "b.jsonl"), executor: new FakeExecutor(twoNodeResponses), input: { topic: "x" }, seed: 3 });
	assert.equal(readFileSync(join(dir, "a.jsonl"), "utf8"), readFileSync(join(dir, "b.jsonl"), "utf8"));
	assert.deepEqual(a.outcome, b.outcome);
	const c = await runWorkflow({ workflow: twoNode, log: join(dir, "c.jsonl"), executor: new FakeExecutor(twoNodeResponses), input: { topic: "x" }, seed: 4 });
	assert.notDeepEqual(c.outcome, a.outcome, "the seed reaches Math.random");
});

test("resume refuses a changed pin and names the field", async () => {
	const dir = tmp();
	const log = join(dir, "run.jsonl");
	await runWorkflow({ workflow: twoNode, log, executor: new FakeExecutor(twoNodeResponses), input: { topic: "x" }, seed: 1 });
	await assert.rejects(
		runWorkflow({ workflow: twoNode, log, executor: new FakeExecutor(twoNodeResponses), seed: 2 }),
		(e: unknown) => e instanceof RunRefused && /pin mismatch: seed/.test(e.message),
	);
	await assert.rejects(
		runWorkflow({ workflow: twoNode, log, executor: new FakeExecutor(twoNodeResponses), seed: 1, models: { writer: "other/model" } }),
		(e: unknown) => e instanceof RunRefused && /models\.writer/.test(e.message),
	);
});

test("resume refuses a changed pinned input file", async () => {
	const dir = tmp();
	const wfDir = join(dir, "wf");
	const { mkdirSync, copyFileSync } = await import("node:fs");
	mkdirSync(wfDir);
	for (const f of ["planner.md", "writer.md"]) copyFileSync(resolve(here, "../examples/two-node", f), join(wfDir, f));
	writeFileSync(
		join(wfDir, "workflow.ts"),
		readFileSync(twoNode, "utf8").replace('name: "two-node",', 'name: "two-node",\n\tpin: { files: ["advice.md"] },'),
	);
	writeFileSync(join(dir, "advice.md"), "v1");
	const log = join(dir, "run.jsonl");
	const opts = { workflow: join(wfDir, "workflow.ts"), log, root: dir, executor: new FakeExecutor(twoNodeResponses), input: { topic: "x" } };
	await runWorkflow(opts);
	writeFileSync(join(dir, "advice.md"), "v2");
	await assert.rejects(runWorkflow(opts), (e: unknown) => e instanceof RunRefused && /inputs\.advice\.md/.test(e.message));
});

test("parallel branches, a sub-workflow, llmMerge, scripts with a compute budget", async () => {
	const dir = tmp();
	const executor = fanoutExecutor();
	const scripts = new FakeScripts({ train: (call) => ({ output: { budget: call.computeMinutes }, minutes: 5 }) });
	const r = await runWorkflow({ workflow: fanout, log: join(dir, "run.jsonl"), executor, scripts, input: null });
	assert.equal(r.outcome.type, "done", JSON.stringify(r.outcome));
	const out = (r.outcome as { value: Record<string, unknown> }).value;
	assert.deepEqual(out.tries, { attempts: 2 });
	assert.deepEqual(out.trained, { budget: 5 });
	assert.match(String(out.refused), /compute minutes/);
	// The merge agent's result, capped at max 2; the archive got its archived item.
	assert.deepEqual(out.findings, [{ content: "f1+f3", confidence: 0.9 }, { content: "f2", confidence: 0.2 }]);
	assert.deepEqual(out.archive, [{ content: "f1", confidence: 0.9 }]);

	const ids = executor.calls.map((c) => c.id);
	assert.deepEqual(ids, ["#0.a#0", "#0.b#0", "#1", "#1/merge/findings", "#2>retry#0", "#2>retry#1"]);
	// The judge view: both branches' errors, no confidence.
	const judge = executor.calls.find((c) => c.agent === "judge")!;
	assert.match(judge.view, /E-a/);
	assert.match(judge.view, /E-b/);
	assert.doesNotMatch(judge.view, /confidence/);
	// Each branch saw the state as of its own request.
	assert.doesNotMatch(executor.calls[1]!.view, /E-a/);
	const state = JSON.parse(r.snapshot).state;
	assert.deepEqual(state.errors, ["E-a", "E-b"]);
});

test("a non-commutative write in a parallel branch is refused into the body", async () => {
	const dir = tmp();
	const wf = join(dir, "workflow.ts");
	writeFileSync(
		wf,
		readFileSync(fanout, "utf8")
			.replace('writes: { errors: "errors" }', 'writes: { log: "errors" }')
			.replace(/run: async \(ctx\) => \{[\s\S]*\n\t\},\n\}\);\n$/, 'run: async (ctx) => {\n\t\ttry { await ctx.parallel({ a: (c) => c.call(scout, { area: "a" }) }); return "accepted"; } catch (e) { return String(e); }\n\t},\n});\n'),
	);
	const r = await runWorkflow({ workflow: wf, log: join(dir, "run.jsonl"), executor: fanoutExecutor(), input: null });
	assert.match(JSON.stringify(r.outcome), /Refused: parallel branch #0\.a writes field log whose reducer is not commutative/);
});

test("the USD budget is checked before each call", async () => {
	const dir = tmp();
	const executor = new FakeExecutor({
		...twoNodeResponses,
		planner: { output: { outline: ["a"], note: "n" }, usage: { usd: 5, tokens: 1, turns: 1 } },
	});
	const wf = join(dir, "workflow.ts");
	const src = readFileSync(twoNode, "utf8").replace('name: "two-node",', 'name: "two-node",\n\tbudget: { usd: 1 },');
	writeFileSync(wf, src.replace(/from "\.\/(planner|writer)\.md"/g, (_m, n) => `from ${JSON.stringify(resolve(here, `../examples/two-node/${n}.md`))}`));
	const r = await runWorkflow({ workflow: wf, log: join(dir, "run.jsonl"), executor, input: { topic: "x" } });
	assert.equal(r.outcome.type, "failed");
	assert.match(JSON.stringify(r.outcome), /budget exhausted: usd 5\.0 of 1\.0/);
	assert.equal(executor.calls.length, 1);
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
