// Write epochs: a read after a write to the same tool source is keyed by
// that write, so a fork where the write re-executes reads the outside
// again, while reads with no write before them (or none that changed)
// still hit. Deterministic across replay and fork.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FakeExecutor, forkRun, runWorkflow } from "../src/host/index.ts";
import { tmp } from "./util.ts";

// A fake outside service: `upload` (unannotated: a write) appends a name; `list` (read-only) lists them.
const TOOLS = `import { Type, type WallisTool } from "wallis";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const state = () => process.env.FAKE_STATE!;
const names = () => (existsSync(state()) ? readFileSync(state(), "utf8").split("\\n").filter(Boolean) : []);
const log = (what: string) => appendFileSync(state() + ".calls", what + "\\n");
const Name = Type.Object({ name: Type.String() });
const Empty = Type.Object({});
export const upload = { name: "upload", label: "upload", description: "Uploads.", parameters: Name,
	execute: async (_id: string, p: { name: string }) => { log("upload " + p.name); appendFileSync(state(), p.name + "\\n"); return { content: [{ type: "text" as const, text: "ok" }], details: undefined, structuredContent: { ok: true } }; } } satisfies WallisTool<typeof Name>;
export const list = { name: "list", label: "list", description: "Lists.", parameters: Empty, annotations: { readOnlyHint: true }, outputSchema: Type.Object({ names: Type.Array(Type.String()) }),
	execute: async () => { log("list"); return { content: [{ type: "text" as const, text: "" }], details: undefined, structuredContent: { names: names() } }; } } satisfies WallisTool<typeof Empty>;
`;

const WORKFLOW = (body: string) => `import { defineModels, defineSandbox, toolset, Type, workflow } from "wallis";
const box = defineSandbox({}, { name: "box", requires: ["node"] });
const ente = toolset<typeof import("./tools/ente.ts")>("./tools/ente.ts", { sandbox: box, secrets: ["FAKE_STATE"] });
export default workflow({ name: "ep", models: defineModels({ default: "fake/default" }), agents: [], toolsets: [ente], input: Type.Null(), output: Type.Any(),
	run: async (ctx) => { ${body} } });\n`;

function project(body: string) {
	const root = tmp("wallis-epochs-");
	mkdirSync(join(root, "wf", "tools"), { recursive: true });
	writeFileSync(join(root, "wf", "tools", "ente.ts"), TOOLS);
	writeFileSync(join(root, "wf", "workflow.ts"), WORKFLOW(body));
	const state = join(root, "ente-state");
	process.env.FAKE_STATE = state;
	const calls = () => (existsSync(`${state}.calls`) ? readFileSync(`${state}.calls`, "utf8").split("\n").filter(Boolean) : []);
	const reset = () => writeFileSync(`${state}.calls`, "");
	const opts = { workflow: join(root, "wf", "workflow.ts"), root, executor: new FakeExecutor({}), confine: "off", bins: { node: process.execPath }, inboxPollMs: null } as const;
	return { root, state, calls, reset, opts };
}

const UPLOAD_THEN_LIST = `
	const before = await ctx.call(ente.list, {});
	await ctx.call(ente.upload, { name: "DSC_2818.jpg" });
	const after = await ctx.call(ente.list, {});
	return { before: before.names, after: after.names };`;

test("a read after a write: a fork that forgets the write reads again; a read with no write before it still hits", async () => {
	const p = project(UPLOAD_THEN_LIST);
	const dir = join(p.root, "r1");
	const first = await runWorkflow({ ...p.opts, dir, input: null });
	assert.deepEqual(first.outcome, { type: "done", value: { before: [], after: ["DSC_2818.jpg"] } });
	assert.deepEqual(p.calls(), ["list", "upload DSC_2818.jpg", "list"]);
	// The outside changes (the album was emptied) and the upload is forgotten: it runs again, and
	// so does the list after it; the list before it has no write upstream and hits.
	writeFileSync(p.state, "");
	p.reset();
	const fork = forkRun(dir, join(p.root, "r2"), { forget: ["#1"] });
	const forked = await runWorkflow({ ...p.opts, dir: fork.dir });
	assert.deepEqual(p.calls(), ["upload DSC_2818.jpg", "list"]);
	assert.deepEqual(forked.outcome, { type: "done", value: { before: [], after: ["DSC_2818.jpg"] } }, "the list is fresh, not the source run's");
	// A fork that forgets nothing hits everything: no write re-executed, so no epoch changed.
	p.reset();
	const plain = forkRun(dir, join(p.root, "r3"));
	const replayed = await runWorkflow({ ...p.opts, dir: plain.dir });
	assert.deepEqual(p.calls(), []);
	assert.deepEqual(replayed.outcome, first.outcome);
	// And a fork of the fork (its upload is now on its second attempt): deterministic, all hits.
	p.reset();
	const again = forkRun(fork.dir, join(p.root, "r4"));
	await runWorkflow({ ...p.opts, dir: again.dir });
	assert.deepEqual(p.calls(), []);
});

test("concurrent branches start from the parent's epoch where they are made; each carries its own chain", async () => {
	const p = project(`
	await ctx.call(ente.upload, { name: "a" });
	const r = await ctx.parallel({
		x: async (c) => (await c.call(ente.list, {})).names,
		y: async (c) => { await c.call(ente.upload, { name: "y" }); return (await c.call(ente.list, {})).names; },
	});
	const late = await ctx.call(ente.list, {});
	return { ...r, late: late.names };`);
	const dir = join(p.root, "r1");
	await runWorkflow({ ...p.opts, dir, input: null });
	// Forget only y's upload: y's list reads again; x's list (y's write is not upstream of it) and the
	// parent's later list (sibling branches' writes are theirs) still hit.
	p.reset();
	const fork = forkRun(dir, join(p.root, "r2"), { forget: ["#1.y#0"] });
	await runWorkflow({ ...p.opts, dir: fork.dir });
	assert.deepEqual(p.calls(), ["upload y", "list"]);
	// Forget the parent's upload: every list after it reads again, in both branches and after them.
	p.reset();
	const parent = forkRun(dir, join(p.root, "r3"), { forget: ["#0"] });
	await runWorkflow({ ...p.opts, dir: parent.dir });
	assert.deepEqual(p.calls().sort(), ["list", "list", "list", "upload a", "upload y"].sort());
});

test("an agent call holding a source's tools is keyed by its epoch; inside a call, a journaled read is reused only at its epoch", async () => {
	const p = project("");
	writeFileSync(
		p.opts.workflow,
		`import { defineAgent, defineModels, defineSandbox, toolset, Type, workflow } from "wallis";
const models = defineModels({ default: "fake/default" });
const box = defineSandbox({}, { name: "box", requires: ["node"] });
const ente = toolset<typeof import("./tools/ente.ts")>("./tools/ente.ts", { sandbox: box, secrets: ["FAKE_STATE"] });
const checker = defineAgent({ models }, { name: "checker", model: "default", prompt: "Check the album.", input: Type.Null(), output: Type.Null(), tools: [ente.list] });
export default workflow({ name: "ep", models, agents: [checker], toolsets: [ente], input: Type.Null(), output: Type.Any(),
	run: async (ctx) => { await ctx.call(ente.upload, { name: "a" }); return (await ctx.call(ctx.session(checker), null))[0]; } });
`,
	);
	const dir = join(p.root, "r1");
	const executor = new FakeExecutor({ checker: { submit: null } });
	await runWorkflow({ ...p.opts, dir, input: null, executor });
	assert.equal(executor.calls.length, 1);
	const hit = new FakeExecutor({});
	await runWorkflow({ ...p.opts, dir: forkRun(dir, join(p.root, "r2")).dir, executor: hit });
	assert.equal(hit.calls.length, 0, "nothing upstream changed: the agent call hits");
	const again = new FakeExecutor({ checker: { submit: null } });
	await runWorkflow({ ...p.opts, dir: forkRun(dir, join(p.root, "r3"), { forget: ["#0"] }).dir, executor: again });
	assert.equal(again.calls.length, 1, "the upload re-executed: the agent, which reads the album, runs again");
	// Within one call: a read journaled at one epoch is not reused at another.
	const { NodeTools } = await import("../src/host/tools.ts");
	const read = { id: "custom:./t.ts#list", source: { kind: "toolset", path: "./t.ts" }, annotations: { readOnlyHint: true } } as never;
	const write = { id: "custom:./t.ts#upload", source: { kind: "toolset", path: "./t.ts" }, annotations: {} } as never;
	const recorded = new Map([["0/c2", { tool: "custom:./t.ts#list", args: {}, outcome: { text: "old" } }]]);
	const tools = new NodeTools({ agent: "a", recorded, log: () => {} } as never, 10, 1000);
	assert.equal(tools.epochFor(read, "0/c1", {}), "", "a read does not advance the epoch");
	const before = tools.epochFor(write, "0/c1", { name: "x" });
	const after = tools.epochFor(read, "0/c2", {});
	assert.equal(before, "");
	assert.notEqual(after, "");
	assert.equal(tools.recorded("0/c2", read, {}, after), null, "journaled before the write's epoch: a miss");
	assert.deepEqual(tools.recorded("0/c2", read, {}, ""), { text: "old", value: undefined, isError: false });
});
