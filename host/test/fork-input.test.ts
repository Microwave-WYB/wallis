// `wallis fork <run> --input`: a fork with a new run input re-executes
// against the copied journal, so only calls whose own inputs change run
// again. The input is parsed against the workflow's input schema before
// anything is written (`invalid_input`, typed), and combines with
// `--forget`.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeCommands, FakeExecutor, forkRun, readMeta, runPaths, runWorkflow } from "../src/host/index.ts";
import { checkWorkflowInput } from "../src/host/query.ts";
import { parseRunId } from "../src/host/capability.ts";
import { Runs } from "../src/host/runs.ts";
import { RunRefused } from "../src/host/session.ts";
import { tmp, wallis } from "./util.ts";

const hostIndex = resolve(fileURLToPath(new URL(".", import.meta.url)), "../src/host/index.ts");

// Stage 1 depends only on `a`; stage 2 on stage 1's output and `b`.
const workflowText = `import { command, defineModels, defineSandbox, Type, workflow } from "wallis";
const box = defineSandbox({}, { name: "box", requires: ["sh"] });
const stage1 = command({ name: "stage1", sandbox: box, input: Type.Object({ a: Type.Number() }), output: Type.Object({ v: Type.Number() }),
	run: (i) => ["sh", "-c", "echo $0", String(i.a * 10)],
	parse: (r) => ({ v: Number(r.stdout.trim()) }) });
const stage2 = command({ name: "stage2", sandbox: box, input: Type.Object({ v: Type.Number(), b: Type.Number() }), output: Type.Object({ w: Type.Number() }),
	run: (i) => ["sh", "-c", "echo $0", String(i.v + i.b)],
	parse: (r) => ({ w: Number(r.stdout.trim()) }) });
export default workflow({ name: "two-stage", models: defineModels({ default: "fake/default" }), agents: [], commands: [stage1, stage2],
	input: Type.Object({ a: Type.Number(), b: Type.Number() }), output: Type.Object({ w: Type.Number() }),
	run: async (ctx, input) => {
		const one = await ctx.call(stage1, { a: input.a });
		return ctx.call(stage2, { v: one.v, b: input.b });
	} });
`;

/** The fake commands echo their last argv word, as \`sh -c 'echo $0' x\` would. */
const echo = () => new FakeCommands({ stage1: (c) => ({ stdout: `${c.argv.at(-1)}\n` }), stage2: (c) => ({ stdout: `${c.argv.at(-1)}\n` }) });
const count = (commands: FakeCommands, name: string) => commands.calls.filter((c) => c.command === name).length;

function setup() {
	const root = tmp("wallis-fork-input-");
	const wf = join(root, ".agents", "workflows", "two-stage");
	mkdirSync(wf, { recursive: true });
	const file = join(wf, "workflow.ts");
	writeFileSync(file, workflowText);
	const base = { confine: "off", inboxPollMs: null, bins: { sh: "/bin/sh" }, workflow: file, executor: new FakeExecutor({}) } as const;
	return { root, file, base };
}

test("fork --input: stage 1 (input a only) hits, stage 2 (b changed) runs once; a fork of a fork too", async () => {
	const { root, file, base } = setup();
	const dir = join(root, "r1");
	const first = echo();
	const done = await runWorkflow({ ...base, dir, input: { a: 1, b: 2 }, commands: first });
	assert.deepEqual(done.outcome, { type: "done", value: { w: 12 } });
	assert.equal(count(first, "stage1"), 1);
	assert.equal(count(first, "stage2"), 1);

	// b changes: stage 1's input is the same, so it is served from the journal.
	const forked = echo();
	const forkA = forkRun(dir, join(root, "r2"), { input: await checkWorkflowInput(file, { a: 1, b: 5 }) });
	const a = await runWorkflow({ ...base, dir: forkA.dir, commands: forked });
	assert.deepEqual(a.outcome, { type: "done", value: { w: 15 } });
	assert.equal(count(forked, "stage1"), 0, "stage 1 is a cache hit");
	assert.equal(count(forked, "stage2"), 1, "stage 2 runs once");
	assert.deepEqual(readMeta(runPaths(forkA.dir))?.forked_from, { run_id: runPaths(dir).id, at: readMeta(runPaths(forkA.dir))!.forked_from!.at, input_changed: true });

	// A fork of the fork, b changed again: the same.
	const again = echo();
	const forkB = forkRun(forkA.dir, join(root, "r3"), { input: await checkWorkflowInput(file, { a: 1, b: 7 }) });
	const b = await runWorkflow({ ...base, dir: forkB.dir, commands: again });
	assert.deepEqual(b.outcome, { type: "done", value: { w: 17 } });
	assert.equal(count(again, "stage1"), 0, "stage 1 is a cache hit in a fork of a fork");
	assert.equal(count(again, "stage2"), 1);

	// The source runs are untouched: their logs still start with their own inputs.
	const startedInput = (d: string) => (JSON.parse(readFileSync(runPaths(d).log, "utf8").split("\n")[0]!) as { input: unknown }).input;
	assert.deepEqual(startedInput(dir), { a: 1, b: 2 });
	assert.deepEqual(startedInput(forkA.dir), { a: 1, b: 5 });
	assert.deepEqual(startedInput(forkB.dir), { a: 1, b: 7 });
});

test("fork --input combined with --forget: the forgotten stage 1 runs again, and stage 2 with the new b", async () => {
	const { root, file, base } = setup();
	const dir = join(root, "r1");
	await runWorkflow({ ...base, dir, input: { a: 1, b: 2 }, commands: echo() });
	const forked = echo();
	const fork = forkRun(dir, join(root, "r2"), { forget: ["#0"], input: await checkWorkflowInput(file, { a: 1, b: 3 }) });
	const r = await runWorkflow({ ...base, dir: fork.dir, commands: forked });
	assert.deepEqual(r.outcome, { type: "done", value: { w: 13 } });
	assert.equal(count(forked, "stage1"), 1, "the forgotten call executes again");
	assert.equal(count(forked, "stage2"), 1);
	const marks = readFileSync(runPaths(fork.dir).log, "utf8").split("\n").filter((l) => l.includes('"call_forgotten"'));
	assert.equal(marks.length, 1);
});

test("fork with an input that does not match the schema is refused with invalid_input, and no run is created", async () => {
	const { root, file, base } = setup();
	await runWorkflow({ ...base, dir: join(root, ".wallis", "runs", "r1"), input: { a: 1, b: 2 }, commands: echo() });
	const runs = () => readdirSync(join(root, ".wallis", "runs")).sort();
	const before = runs();

	// The check itself.
	await assert.rejects(checkWorkflowInput(file, { a: 1, b: "two" }), (e: unknown) => e instanceof RunRefused && e.refusal.type === "invalid_input" && e.refusal.errors.length > 0);

	// The CLI: a schema mismatch and text that is not JSON, both typed, as JSON.
	for (const input of ['{"a":1}', "not json"]) {
		const r = wallis(root, ["fork", "r1", "--input", input, "--json"]);
		assert.equal(r.status, 1, r.stderr);
		const refused = (JSON.parse(r.stdout) as { refused: { type: string; errors: string[] } }).refused;
		assert.equal(refused.type, "invalid_input");
		assert.ok(refused.errors.length > 0);
	}
	const badFile = join(root, "bad.json");
	writeFileSync(badFile, JSON.stringify({ a: "x", b: 2 }));
	assert.equal(wallis(root, ["fork", "r1", "--input-file", badFile, "--json"]).status, 1);

	// MCP (`Runs.fork`): the same refusal.
	const kit = { executor: new FakeExecutor({}), commands: echo(), confine: "off" as const };
	await assert.rejects(new Runs(root, kit, null, "human").fork(parseRunId("r1"), [], { a: 1, b: null }), (e: unknown) => e instanceof RunRefused && e.refusal.type === "invalid_input");

	assert.deepEqual(runs(), before, "no run is created");
});

test("CLI: wallis run then fork --input --json prints one JSON object with the new run id; only stage 2 runs again", () => {
	const root = tmp("wallis-fork-input-cli-");
	const wf = join(root, ".agents", "workflows", "two-stage");
	mkdirSync(wf, { recursive: true });
	writeFileSync(join(wf, "workflow.ts"), workflowText);
	// An executor kit with fake commands that log every execution to a file.
	const kit = join(root, "kit.ts");
	writeFileSync(
		kit,
		`import { appendFileSync } from "node:fs";
import { FakeCommands, FakeExecutor } from ${JSON.stringify(hostIndex)};
export default function create() {
	const log = (c) => { appendFileSync(process.env.WALLIS_FORK_INPUT_LOG, c.command + "\\n"); return { stdout: c.argv.at(-1) + "\\n" }; };
	return { executor: new FakeExecutor({}), commands: new FakeCommands({ stage1: log, stage2: log }), confine: "off" };
}
`,
	);
	const execLog = join(root, "exec.log");
	const env = { WALLIS_FORK_INPUT_LOG: execLog };
	const json = (args: string[]) => {
		const r = wallis(root, [...args, "--json", "--executor", kit], env);
		assert.equal(r.status, 0, r.stderr);
		const lines = r.stdout.trim().split("\n");
		assert.equal(lines.length, 1, `one JSON object, got: ${r.stdout}`);
		return JSON.parse(lines[0]!) as { run_id: string; status: { type: string } | null; output: unknown; [k: string]: unknown };
	};
	const executed = () => (existsSync(execLog) ? readFileSync(execLog, "utf8").trim().split("\n") : []);

	const started = json(["run", "two-stage", "--input", JSON.stringify({ a: 1, b: 2 })]);
	assert.equal(started.status?.type, "finished");
	assert.deepEqual(started.output, { w: 12 });
	assert.deepEqual(executed(), ["stage1", "stage2"]);

	const forked = json(["fork", started.run_id, "--input", JSON.stringify({ a: 1, b: 4 })]);
	assert.notEqual(forked.run_id, started.run_id);
	assert.ok(existsSync(join(root, ".wallis", "runs", forked.run_id)), "the printed run id is the new run");
	assert.equal(forked.forked_from, started.run_id);
	assert.equal(forked.input_changed, true);
	assert.deepEqual(forked.forgotten, []);
	assert.equal(forked.status?.type, "finished");
	assert.deepEqual(forked.output, { w: 14 });
	assert.deepEqual(executed(), ["stage1", "stage2", "stage2"], "only stage 2 executes in the fork");
});
