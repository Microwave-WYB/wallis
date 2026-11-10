// Identity by digest or structure; names are labels only. A node is its
// definition digest (renaming it, or its sandbox, keeps its journal
// entries); a custom tool is (its toolset's bundle digest, export), and a
// run's toolsets are bundled once, when it starts: later hosts run the
// pinned bundle whatever the source is now.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appendInbox, EventLog, FakeCommands, FakeExecutor, forkRun, runPaths, runWorkflow } from "../src/host/index.ts";
import { tmp } from "./util.ts";

const workflowText = (n: { agent: string; command: string; sandbox: string }) => `
import { command, defineAgent, defineModels, defineSandbox, orchestrator, toolset, Type, workflow } from "wallis";
const models = defineModels({ default: "fake/default" });
const box = defineSandbox({}, { name: "${n.sandbox}", requires: ["sh", "node"] });
const lib = toolset<typeof import("./tools/lib.ts")>("./tools/lib.ts", { sandbox: box });
const echo = command({ name: "${n.command}", sandbox: box, input: Type.Object({ n: Type.Number() }), output: Type.Any(), run: ["sh", "-c", "cat"] });
const writer = defineAgent({ models }, { name: "${n.agent}", model: "default", prompt: "p", input: Type.Null(), output: Type.Object({ ok: Type.Boolean() }), maxTurns: 2 });
const go = orchestrator({ name: "go", input: Type.Null(), output: Type.Boolean() });
export default workflow({
	name: "ident",
	models,
	agents: [writer],
	commands: [echo],
	orchestrators: [go],
	toolsets: [lib],
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => {
		const [a] = await ctx.call(ctx.session(writer), null);
		const c = await ctx.call(echo, { n: 1 });
		await ctx.call(go, null);
		const t = await ctx.call(lib.say, {});
		return { a, c, t };
	},
});
`;

const toolText = (word: string) => `
import { Type, type WallisTool } from "wallis";
const Empty = Type.Object({});
export const say = {
	name: "say", label: "say", description: "Says a word.", parameters: Empty, replay: "safe",
	outputSchema: Type.Object({ word: Type.String() }),
	annotations: { readOnlyHint: true },
	execute: async () => ({ content: [{ type: "text", text: "${word}" }], details: undefined, structuredContent: { word: "${word}" } }),
} satisfies WallisTool<typeof Empty>;
`;

function project() {
	const root = tmp("wallis-ident-");
	const dir = join(root, "wf");
	mkdirSync(join(dir, "tools"), { recursive: true });
	writeFileSync(join(dir, "workflow.ts"), workflowText({ agent: "writer", command: "echo", sandbox: "box" }));
	writeFileSync(join(dir, "tools", "lib.ts"), toolText("first"));
	return { root, workflow: join(dir, "workflow.ts"), tool: join(dir, "tools", "lib.ts") };
}

const base = { confine: "off", inboxPollMs: null, bins: { sh: "/bin/sh", node: process.execPath } } as const;
const answer = (dir: string) => appendInbox(runPaths(dir), { id: "a1", type: "submit", node: "#2", value: true, by: "human" });

test("a run's toolsets are bundled once, when it starts: a later host runs the pinned bundle", async () => {
	const p = project();
	const dir = join(p.root, "run");
	const first = await runWorkflow({ ...base, workflow: p.workflow, dir, root: p.root, input: null, executor: new FakeExecutor({ writer: { submit: { ok: true } } }), commands: new FakeCommands({ echo: { stdout: '{"n":1}' } }) });
	assert.equal(first.run.nodes.at(-1)?.type, "orchestrator_pending");
	const started = new EventLog(join(dir, "log.jsonl")).read()[0] as { pin: { inputs: Record<string, string> } };
	assert.match(started.pin.inputs["toolset:./tools/lib.ts"]!, /^sha256:[0-9a-f]{64}$/);
	// The source changes while the run waits; the tool is first called after it.
	writeFileSync(p.tool, toolText("second"));
	answer(dir);
	const done = await runWorkflow({ ...base, workflow: p.workflow, dir, root: p.root, executor: new FakeExecutor({}) });
	assert.deepEqual(done.outcome, { type: "done", value: { a: { ok: true }, c: { n: 1 }, t: { word: "first" } } });
	// A new run bundles the source as it is now.
	const other = join(p.root, "run2");
	await runWorkflow({ ...base, workflow: p.workflow, dir: other, root: p.root, input: null, executor: new FakeExecutor({ writer: { submit: { ok: true } } }), commands: new FakeCommands({ echo: { stdout: '{"n":1}' } }) });
	answer(other);
	const fresh = await runWorkflow({ ...base, workflow: p.workflow, dir: other, root: p.root, executor: new FakeExecutor({}) });
	assert.deepEqual((fresh.outcome as unknown as { value: { t: unknown } }).value.t, { word: "second" });
});

test("names are labels: renaming an agent, a command and a sandbox keeps their journal entries", async () => {
	const p = project();
	const dir = join(p.root, "run");
	await runWorkflow({ ...base, workflow: p.workflow, dir, root: p.root, input: null, executor: new FakeExecutor({ writer: { submit: { ok: true } } }), commands: new FakeCommands({ echo: { stdout: '{"n":1}' } }) });
	answer(dir);
	const done = await runWorkflow({ ...base, workflow: p.workflow, dir, root: p.root, executor: new FakeExecutor({}) });
	assert.equal(done.outcome?.type, "done");
	// The same definitions under other names: the fork re-runs the body, and every call hits.
	writeFileSync(p.workflow, workflowText({ agent: "author", command: "repeat", sandbox: "shell" }));
	const fork = forkRun(dir, join(p.root, "fork"));
	const executor = new FakeExecutor({});
	const commands = new FakeCommands({});
	const again = await runWorkflow({ ...base, workflow: p.workflow, dir: fork.dir, root: p.root, executor, commands });
	assert.deepEqual(again.outcome, done.outcome);
	assert.equal(executor.calls.length, 0);
	assert.equal(commands.calls.length, 0);
});

test("ids map to node dir names one to one; parallel keys never read as another id's path", async () => {
	const { nodeDirName } = await import("../src/host/artifacts.ts");
	assert.equal(nodeDirName("#0.slow#0"), "_0.slow_0");
	const ids = ["#0.a#1", "#0.a_1", "#0.a-1", "#0.a b#0", "#0.a_b#0", "#0.a-u#0", "#0.a_#0", "#0.a#_0", ".", ".."];
	assert.equal(new Set(ids.map(nodeDirName)).size, ids.length);
	for (const id of ids) assert.match(nodeDirName(id), /^[A-Za-z0-9._-]+$/);
	assert.ok(![".", ".."].includes(nodeDirName(".")));
});

test("a parallel key is escaped in request ids; a toolset declared twice with different options is an error", async () => {
	const { branchKey, declarations } = await import("../src/sdk/runtime.ts");
	const { defineModels, defineSandbox, toolset, Type, workflow } = await import("../src/sdk/index.ts");
	// "a#0.b" would otherwise read as branch "a", request 0, branch "b".
	assert.doesNotMatch(branchKey("a#0.b>c~1"), /[#.>~]/);
	assert.notEqual(branchKey("a%23"), branchKey("a#"));
	const box = defineSandbox({}, { name: "box", requires: ["node"] });
	const base = { name: "n", models: defineModels({ default: "fake/default" }), agents: [], input: Type.Null(), output: Type.Null(), run: async () => null };
	const a = toolset("./tools/lib.ts", { sandbox: box });
	const b = toolset("./tools/lib.ts", { sandbox: box, secrets: ["TOKEN"] });
	assert.throws(() => declarations(workflow({ ...base, toolsets: [a, b] })), /toolset .\/tools\/lib.ts is declared twice/);
	assert.doesNotThrow(() => declarations(workflow({ ...base, toolsets: [a, a] })));
});
