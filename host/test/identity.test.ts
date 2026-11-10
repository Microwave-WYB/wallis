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

test("an undeclared node, agent or tool is refused at run time, even under a declared name", async () => {
	const { fileURLToPath } = await import("node:url");
	const workflow = fileURLToPath(new URL("fixtures/undeclared/workflow.ts", import.meta.url));
	const commands = new FakeCommands({});
	const done = await runWorkflow({ ...base, bins: { sh: "/bin/sh" }, workflow, dir: join(tmp(), "run"), input: null, executor: new FakeExecutor({}), commands });
	assert.deepEqual(done.outcome, { type: "done", value: { command: "unknown_command", agent: "unknown_agent", orchestrator: "unknown_orchestrator", tool: "unknown_tool" } });
	assert.equal(commands.calls.length, 0);
});

test("describe summarizes capabilities: write-capable tools and who holds them, questions, exec, network, binds", async () => {
	const { describeWorkflow } = await import("../src/host/describe.ts");
	const root = tmp("wallis-caps-");
	const dir = join(root, "wf");
	mkdirSync(join(dir, "tools"), { recursive: true });
	mkdirSync(join(dir, "scripts"));
	writeFileSync(
		join(dir, "tools", "lib.ts"),
		`import { Type, type WallisTool } from "wallis";
export const post = { name: "post", label: "post", description: "Posts.", parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) } satisfies WallisTool<ReturnType<typeof Type.Object>>;\n`,
	);
	writeFileSync(
		join(dir, "workflow.ts"),
		`import { defineAgent, defineModels, defineSandbox, orchestrator, toolset, Type, workflow } from "wallis";
const models = defineModels({ default: "fake/default" });
const shell = defineSandbox({}, { name: "shell", requires: ["bash"], volumes: ["./scripts:/scripts:ro", "cache:/var/cache/x"] });
const node = defineSandbox({}, { name: "node", requires: ["node"] });
const lib = toolset<typeof import("./tools/lib.ts")>("./tools/lib.ts", { sandbox: node });
const poster = defineAgent({ models }, { name: "poster", model: "default", prompt: "p", input: Type.Null(), output: Type.Null(), tools: [lib.post] });
const coder = defineAgent({ models }, { name: "coder", model: "default", prompt: "p", input: Type.Null(), output: Type.Null(), workspace: { access: "exec", sandbox: shell } });
const ok = orchestrator({ name: "ok", description: "Publish it?", input: Type.Null(), output: Type.Boolean() });
export default workflow({ name: "caps", models, agents: [poster, coder], orchestrators: [ok], toolsets: [lib], input: Type.Null(), output: Type.Any(), run: async () => null });\n`,
	);
	await runWorkflow({ ...base, bins: { bash: "/bin/bash", node: process.execPath }, workflow: join(dir, "workflow.ts"), dir: join(root, ".wallis", "runs", "r1"), root, input: null, executor: new FakeExecutor({}) });
	const d = (await describeWorkflow(join(dir, "workflow.ts"), root)) as { capabilities: unknown };
	assert.deepEqual(d.capabilities, {
		writes: { from_run: "r1", tools: { "custom:./tools/lib.ts#post": ["poster"] } },
		questions: [{ name: "ok", description: "Publish it?" }],
		exec_agents: [{ agent: "coder", sandbox: "shell" }],
		network: { toolsets: ["./tools/lib.ts"], mcp_servers: [], sandboxes: [] },
		bind_volumes: [{ sandbox: "shell", host: "./scripts", target: "/scripts" }],
	});
});

test("fork --forget: forgotten calls execute again in the fork; the rest hit; a bad id leaves no fork", async () => {
	const { existsSync } = await import("node:fs");
	const { RunRefused } = await import("../src/host/index.ts");
	const p = project();
	const dir = join(p.root, "run");
	await runWorkflow({ ...base, workflow: p.workflow, dir, root: p.root, input: null, executor: new FakeExecutor({ writer: { submit: { ok: true } } }), commands: new FakeCommands({ echo: { stdout: '{"n":1}' } }) });
	answer(dir);
	const done = await runWorkflow({ ...base, workflow: p.workflow, dir, root: p.root, executor: new FakeExecutor({}) });
	// Forget the command (#1): it runs again; the agent before it and the question after it hit.
	const fork = forkRun(dir, join(p.root, "fork"), { forget: ["#1"] });
	const executor = new FakeExecutor({});
	const commands = new FakeCommands({ echo: { stdout: '{"n":2}' } });
	const again = await runWorkflow({ ...base, workflow: p.workflow, dir: fork.dir, root: p.root, executor, commands });
	assert.equal(commands.calls.length, 1);
	assert.equal(executor.calls.length, 0);
	assert.deepEqual(again.outcome, { type: "done", value: { ...(done.outcome as unknown as { value: object }).value, c: { n: 2 } } });
	// The journal keeps the earlier attempt: the fork's log has the mark.
	assert.ok(new EventLog(join(fork.dir, "log.jsonl")).read().some((e) => e.type === "call_forgotten" && e.node === "#1"));
	// Forget the agent (#0): it runs again.
	const second = forkRun(dir, join(p.root, "fork2"), { forget: ["#0"] });
	const writer = new FakeExecutor({ writer: { submit: { ok: false } } });
	const redone = await runWorkflow({ ...base, workflow: p.workflow, dir: second.dir, root: p.root, executor: writer, commands: new FakeCommands({}) });
	assert.equal(writer.calls.length, 1);
	assert.deepEqual((redone.outcome as unknown as { value: { a: unknown } }).value.a, { ok: false });
	// A call the run never made is refused, typed, and no fork is left behind.
	assert.throws(
		() => forkRun(dir, join(p.root, "fork3"), { forget: ["#9"] }),
		(e: unknown) => e instanceof RunRefused && JSON.stringify(e.refusal) === JSON.stringify({ type: "not_live", node: "#9" }),
	);
	assert.ok(!existsSync(join(p.root, "fork3")));
});

test("a custom tool's identity includes where it runs: editing data bound into its toolset's sandbox misses", async () => {
	const root = tmp("wallis-tool-env-");
	const dir = join(root, "wf");
	mkdirSync(join(dir, "tools"), { recursive: true });
	mkdirSync(join(dir, "data"));
	writeFileSync(join(dir, "data", "words"), "one");
	writeFileSync(join(dir, "tools", "lib.ts"), toolText("first"));
	writeFileSync(
		join(dir, "workflow.ts"),
		`import { defineModels, defineSandbox, toolset, Type, workflow } from "wallis";
const box = defineSandbox({}, { name: "box", requires: ["node"], volumes: ["./data:/data:ro"] });
const lib = toolset<typeof import("./tools/lib.ts")>("./tools/lib.ts", { sandbox: box });
export default workflow({ name: "te", models: defineModels({ default: "fake/default" }), agents: [], toolsets: [lib], input: Type.Null(), output: Type.Any(), run: async (ctx) => ctx.call(lib.say, {}) });\n`,
	);
	const opts = { ...base, bins: { node: process.execPath }, workflow: join(dir, "workflow.ts"), root, executor: new FakeExecutor({}) };
	const toolDigest = (run: string) => new EventLog(join(run, "log.jsonl")).read().flatMap((e) => (e.type === "requested" ? [e.node_digest] : []))[0];
	const first = join(root, "r1");
	await runWorkflow({ ...opts, dir: first, input: null });
	const same = forkRun(first, join(root, "r2"));
	await runWorkflow({ ...opts, dir: same.dir });
	const requests = (run: string) => new EventLog(join(run, "log.jsonl")).read().filter((e) => e.type === "requested").length;
	assert.equal(requests(same.dir), 1, "unchanged: a hit (hits are not logged as requests)");
	assert.ok(toolDigest(first));
	writeFileSync(join(dir, "data", "words"), "two");
	const edited = forkRun(first, join(root, "r3"));
	await runWorkflow({ ...opts, dir: edited.dir });
	const digests = new EventLog(join(edited.dir, "log.jsonl")).read().flatMap((e) => (e.type === "requested" ? [e.node_digest] : []));
	assert.equal(digests.length, 2, "the fork's tool call is a new call");
	assert.notEqual(digests[1], digests[0]);
});
