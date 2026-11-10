// Small frictions the film workflow found: a command's parse sees its
// input; ctx.map takes a concurrency limit; an agent's rendered input shows
// where its artifacts are; full loop states for `tree --full`; cache hits
// logged.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EventLog, FakeCommands, FakeExecutor, runWorkflow } from "../src/host/index.ts";
import { tmp } from "./util.ts";

/** A throwaway workflow from its body (and declarations before it). */
function workflow(head: string, body: string): string {
	const dir = join(tmp("wallis-friction-"), "wf");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "workflow.ts"),
		`import { Artifact, command, defineAgent, defineModels, defineSandbox, Type, workflow } from "wallis";
const models = defineModels({ default: "fake/default" });
const box = defineSandbox({}, { name: "box", requires: ["sh"] });
${head}
export default workflow({ name: "friction", models, ${body} });\n`,
	);
	return join(dir, "workflow.ts");
}

const base = { confine: "off", inboxPollMs: null, bins: { sh: "/bin/sh" }, input: null } as const;

test("a command's parse sees the call's input", async () => {
	const wf = workflow(
		`const scale = command({ name: "scale", sandbox: box, input: Type.Object({ n: Type.Number() }), output: Type.Object({ n: Type.Number(), said: Type.String() }), run: ["sh", "-c", "echo hi"],
	parse: (r, input) => ({ n: input.n * 2, said: r.stdout.trim() }) });`,
		`agents: [], commands: [scale], input: Type.Null(), output: Type.Any(), run: async (ctx) => ctx.call(scale, { n: 21 })`,
	);
	const r = await runWorkflow({ ...base, workflow: wf, dir: join(tmp(), "run"), executor: new FakeExecutor({}), commands: new FakeCommands({ scale: { stdout: "hi\n" } }) });
	assert.deepEqual(r.outcome, { type: "done", value: { n: 42, said: "hi" } });
});

test("ctx.map with a concurrency limit runs at most that many branches at once; ids and results are the same", async () => {
	const wf = (limit: string) =>
		workflow(
			`const step = command({ name: "step", sandbox: box, input: Type.Object({ i: Type.Number() }), output: Type.Object({ i: Type.Number() }), run: ["sh", "-c", "cat"] });`,
			`agents: [], commands: [step], input: Type.Null(), output: Type.Any(), run: async (ctx) => ctx.map([0, 1, 2, 3, 4], async (c, i) => (await c.call(step, { i })).i${limit})`,
		);
	const run = async (limit: string) => {
		let now = 0;
		let most = 0;
		const commands = {
			run: async (call: { input: unknown }) => {
				most = Math.max(most, ++now);
				await new Promise((r) => setTimeout(r, 20));
				now--;
				return { exit: 0, stdout: JSON.stringify(call.input), stderr: "", minutes: 0, timedOut: false, limit: null };
			},
		};
		const dir = join(tmp(), "run");
		const r = await runWorkflow({ ...base, workflow: wf(limit), dir, executor: new FakeExecutor({}), commands });
		const ids = new EventLog(join(dir, "log.jsonl")).read().flatMap((e) => (e.type === "requested" ? [e.id] : []));
		return { value: (r.outcome as unknown as { value: unknown }).value, most, ids };
	};
	const limited = await run(", { concurrency: 2 }");
	const free = await run("");
	assert.deepEqual(limited.value, [0, 1, 2, 3, 4]);
	assert.equal(limited.most, 2);
	assert.equal(free.most, 5);
	assert.deepEqual(limited.ids, free.ids);
	const bad = await runWorkflow({ ...base, workflow: wf(", { concurrency: 0 }"), dir: join(tmp(), "run"), executor: new FakeExecutor({}), commands: new FakeCommands({}) });
	assert.equal(bad.outcome?.type, "failed");
	assert.match(JSON.stringify(bad.outcome), /concurrency must be a positive integer/);
});

test("an agent's rendered input shows the /in path of each input artifact", async () => {
	const wf = workflow(
		`const make = command({ name: "make", sandbox: box, input: Type.Null(), output: Type.Object({ sheet: Artifact("image/png") }), run: ["sh", "-c", "true"], parse: (r) => ({ sheet: r.file("sheet.png", "image/png") }) });
const look = defineAgent({ models }, { name: "look", model: "default", prompt: "Look.", input: Type.Object({ sheet: Artifact("image/png") }), output: Type.Null(), workspace: { access: "read" } });`,
		`agents: [look], commands: [make], input: Type.Null(), output: Type.Any(), run: async (ctx) => { const m = await ctx.call(make, null); return (await ctx.call(ctx.session(look), { sheet: m.sheet }))[0]; }`,
	);
	const commands = { run: async (call: { workspace: { scratch: string } }) => (writeFileSync(join(call.workspace.scratch, "sheet.png"), "png"), { exit: 0, stdout: "", stderr: "", minutes: 0, timedOut: false, limit: null }) };
	const executor = new FakeExecutor({ look: { submit: null } });
	const r = await runWorkflow({ ...base, workflow: wf, dir: join(tmp(), "run"), executor, commands });
	assert.equal(r.outcome?.type, "done", JSON.stringify(r.status));
	const prompt = executor.calls[0]!.prompt;
	assert.match(prompt, /"path": "\/in\/[0-9a-f]{64}\/sheet\.png"/);
});

test("a host session's cache hits are one host fact; a fork does not inherit it", async () => {
	const wf = workflow(
		`const step = command({ name: "step", sandbox: box, input: Type.Object({ i: Type.Number() }), output: Type.Any(), run: ["sh", "-c", "cat"] });`,
		`agents: [], commands: [step], input: Type.Null(), output: Type.Any(), run: async (ctx) => ctx.map([0, 1, 2], async (c, i) => c.call(step, { i }))`,
	);
	const { forkRun } = await import("../src/host/index.ts");
	const facts = (dir: string) => new EventLog(join(dir, "log.jsonl")).read().flatMap((e) => (e.type === "noted" && (e.key === "hits" || e.key.startsWith("hit ")) ? [e] : []));
	const dir = join(tmp(), "run");
	await runWorkflow({ ...base, workflow: wf, dir, executor: new FakeExecutor({}), commands: new FakeCommands({ step: { stdout: "1" } }) });
	assert.deepEqual(facts(dir), [], "nothing was reused the first time");
	const fork = forkRun(dir, join(tmp(), "fork"));
	await runWorkflow({ ...base, workflow: wf, dir: fork.dir, executor: new FakeExecutor({}), commands: new FakeCommands({}) });
	const once = facts(fork.dir);
	assert.equal(once.length, 1, "one event for the host session, not one per hit");
	const value = (once[0] as unknown as { value: { count: number; by_kind: object; ids: string[]; digest: string } }).value;
	assert.equal(value.count, 3);
	assert.deepEqual(value.by_kind, { command: 3 });
	assert.deepEqual(value.ids, ["#0.0#0", "#0.1#0", "#0.2#0"]);
	assert.match(value.digest, /^sha256:[0-9a-f]{64}$/);
	// A fork of the fork starts with no hits of its own.
	const again = forkRun(fork.dir, join(tmp(), "fork2"));
	assert.deepEqual(facts(again.dir), []);
});

test("tree --full shows each loop iteration's whole state; the log keeps a long one truncated, whole in the store", async () => {
	const { inspectRun, renderTree } = await import("../src/host/query.ts");
	const wf = workflow(
		``,
		`agents: [], input: Type.Null(), output: Type.Any(), run: async (ctx) => ctx.loop({ i: 0, notes: "" }, async (_c, s) => (s.i === 2 ? done(s.i) : next({ i: s.i + 1, notes: "x".repeat(3000) + "END" })))`,
	);
	writeFileSync(wf, readFileSync(wf, "utf8").replace("import { Artifact,", "import { done, next, Artifact,"));
	const dir = join(tmp(), "run");
	const r = await runWorkflow({ ...base, bins: {}, workflow: wf, dir, executor: new FakeExecutor({}), commands: new FakeCommands({}) });
	assert.deepEqual(r.outcome, { type: "done", value: 2 });
	const logged = new EventLog(join(dir, "log.jsonl")).read().filter((e) => e.type === "observed" && e.at === "#0.1");
	assert.equal(logged.length, 1);
	assert.ok(JSON.stringify(logged[0]).length < 2500, "the log keeps it truncated");
	const short = renderTree(inspectRun(dir));
	assert.doesNotMatch(short, /END/);
	const full = renderTree(inspectRun(dir), { full: true });
	assert.match(full, /"notes": "x{3000}END"/);
	assert.match(full, /"i": 0/);
});

test("a command that executed again and gave another output is a typed warning, in status, tree and describe; nothing else changes", async () => {
	const { forkRun } = await import("../src/host/index.ts");
	const { inspectRun, renderTree } = await import("../src/host/query.ts");
	const { describeWorkflow } = await import("../src/host/describe.ts");
	// A command whose output embeds the current time (like darktable's ICC header).
	const wf = workflow(
		`const stamp = command({ name: "stamp", sandbox: box, input: Type.Null(), output: Type.Object({ at: Type.String() }), run: ["sh", "-c", "date +%s%N"], parse: (r) => ({ at: r.stdout.trim() }) });`,
		`agents: [], commands: [stamp], input: Type.Null(), output: Type.Any(), run: async (ctx) => ctx.call(stamp, null)`,
	);
	let n = 0;
	const clock = { run: async () => ({ exit: 0, stdout: `${Date.now()}${n++}\n`, stderr: "", minutes: 0, timedOut: false, limit: null }) };
	const root = join(tmp(), "proj");
	const dir = join(root, ".wallis", "runs", "r1");
	await runWorkflow({ ...base, workflow: wf, dir, root, executor: new FakeExecutor({}), commands: clock });
	assert.deepEqual(inspectRun(dir).warnings, []);
	const fork = forkRun(dir, join(root, ".wallis", "runs", "r2"), { forget: ["#0"] });
	const r = await runWorkflow({ ...base, workflow: wf, dir: fork.dir, root, executor: new FakeExecutor({}), commands: clock });
	assert.equal(r.outcome?.type, "done", "no behaviour change");
	const [w] = inspectRun(fork.dir).warnings;
	assert.equal(w?.type, "nondeterministic_output");
	assert.equal(w?.node, "#0");
	assert.match(w!.previous, /^sha256:[0-9a-f]{64}$/);
	assert.notEqual(w!.previous, w!.current);
	assert.match(renderTree(inspectRun(fork.dir)), /warning: #0 executed again and its output changed/);
	const described = (await describeWorkflow(wf, root)) as { nondeterministic_outputs: { run: string }[] };
	assert.deepEqual(described.nondeterministic_outputs.map((x) => x.run), ["r2"]);
	// The same output again: no warning.
	const steady = { run: async () => ({ exit: 0, stdout: "same\n", stderr: "", minutes: 0, timedOut: false, limit: null }) };
	const d2 = join(root, ".wallis", "runs", "r3");
	await runWorkflow({ ...base, workflow: wf, dir: d2, root, input: null, executor: new FakeExecutor({}), commands: steady });
	const f2 = forkRun(d2, join(root, ".wallis", "runs", "r4"), { forget: ["#0"] });
	await runWorkflow({ ...base, workflow: wf, dir: f2.dir, root, executor: new FakeExecutor({}), commands: steady });
	assert.deepEqual(inspectRun(f2.dir).warnings, []);
});

test("wallis export --output: every artifact of the output at its JSON path, Trees as dirs, output.json with paths", async () => {
	const { exportOutput } = await import("../src/host/index.ts");
	const { readdirSync } = await import("node:fs");
	const { wallis, project: newProject } = await import("./util.ts");
	const wf = workflow(
		`const develop = command({ name: "develop", sandbox: box, input: Type.Object({ n: Type.String() }), output: Type.Object({ jpg: Artifact("image/jpeg") }), run: ["sh", "-c", "true"], parse: (r, i) => ({ jpg: r.file(i.n, "image/jpeg") }) });
const edit = defineAgent({ models }, { name: "edit", model: "default", prompt: "Edit.", input: Type.Null(), output: Type.Null(), workspace: { access: "write" } });`,
		`agents: [edit], commands: [develop], input: Type.Null(), output: Type.Any(), run: async (ctx) => {
		const finals = await ctx.map(["DSC_2818.jpg", "DSC_2819.jpg"], async (c, n) => (await c.call(develop, { n })).jpg);
		const [, s] = await ctx.call(ctx.session(edit), null);
		return { finals, notes: "two", workspace: ctx.files(s) };
	}`,
	);
	const commands = { run: async (call: { input: unknown; workspace: { scratch: string } }) => (writeFileSync(join(call.workspace.scratch, (call.input as { n: string }).n), `jpeg ${(call.input as { n: string }).n}`), { exit: 0, stdout: "", stderr: "", minutes: 0, timedOut: false, limit: null }) };
	const executor = new FakeExecutor({ edit: (call) => (mkdirSync(join(call.workspace.scratch, "sub"), { recursive: true }), writeFileSync(join(call.workspace.scratch, "sub", "edit.xmp"), "xmp"), { submit: null }) });
	const root = newProject();
	const dir = join(root, ".wallis", "runs", "r1");
	const r = await runWorkflow({ ...base, workflow: wf, dir, root, executor, commands });
	assert.equal(r.outcome?.type, "done", JSON.stringify(r.status));
	const target = join(tmp(), "out");
	const files = exportOutput(dir, target);
	assert.deepEqual(files.sort(), ["finals/0/DSC_2818.jpg", "finals/1/DSC_2819.jpg", "output.json", "workspace/sub/edit.xmp"]);
	assert.equal(readFileSync(join(target, "finals", "1", "DSC_2819.jpg"), "utf8"), "jpeg DSC_2819.jpg");
	assert.equal(readFileSync(join(target, "workspace", "sub", "edit.xmp"), "utf8"), "xmp");
	const output = JSON.parse(readFileSync(join(target, "output.json"), "utf8")) as { finals: { path: string; digest: string }[]; notes: string; workspace: { path: string } };
	assert.deepEqual(output.finals.map((f) => f.path), ["finals/0/DSC_2818.jpg", "finals/1/DSC_2819.jpg"]);
	assert.match(output.finals[0]!.digest, /^sha256:/);
	assert.equal(output.notes, "two");
	assert.equal(output.workspace.path, "workspace");
	// A non-empty dir is refused; --merge exports into it, but never over other content.
	assert.throws(() => exportOutput(dir, target), /is not empty/);
	assert.deepEqual(exportOutput(dir, target, { merge: true }), [], "the same files are already there");
	writeFileSync(join(target, "finals", "0", "DSC_2818.jpg"), "changed");
	assert.throws(() => exportOutput(dir, target, { merge: true }), /exists with other content/);
	// The CLI.
	const viaCli = join(tmp(), "cli-out");
	const res = wallis(root, ["export", "r1", "--output", viaCli, "--json"]);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual((JSON.parse(res.stdout) as { files: string[] }).files.sort(), files.sort());
	assert.ok(readdirSync(viaCli).includes("output.json"));
});
