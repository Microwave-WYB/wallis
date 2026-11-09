// Compile-time checks of the SDK's and the host's typing. `tsc --noEmit`
// fails if any `@ts-expect-error` line stops being an error.

import { command, Decision, defineAgent, defineMcp, defineModels, defineMounts, defineSandbox, Foldable, mcpTool, orchestrator, subWorkflow, Type, workflow } from "wallis";
import { IdleNode, LiveNode, OwnedRun, SteerableNode, SubmittableNode } from "../src/host/capability.ts";
import type { CommandRunning, IdleNodeState, Node, RunningNode, Snapshot } from "../src/host/core.ts";
import type { Session } from "../src/host/session.ts";

const models = defineModels({ default: "p/m", judge: "" });
const mcp = defineMcp({ mcpServers: { arxiv: { command: "uvx", args: ["arxiv-mcp-server==0.2.10"] } } });
const mounts = defineMounts({ kb: "./knowledge", data: "" });

const py = defineSandbox({ mounts }, { name: "py", requires: ["uv", { name: "bash", check: ["bash", "--version"] }], mounts: ["kb"] });

const train = command({
	name: "train",
	sandbox: py,
	input: Type.Object({ model: Type.Object({ digest: Type.String(), name: Type.String(), media: Type.String() }), epochs: Type.Integer() }),
	output: Type.Object({ score: Type.Number() }),
	// An input artifact appears in `run` as its mounted form, with its path.
	run: (i) => ["uv", "run", "--offline", "train.py", "--model", i.model.path, "--epochs", String(i.epochs)],
	parse: (r) => ({ score: Number(r.stdout.trim()) }),
});

const ok = defineAgent(
	{ models, mcp },
	{
		name: "ok",
		model: "judge",
		prompt: "p",
		input: Type.Object({ q: Type.String(), papers: Foldable(Type.Array(Type.String()), { maxChars: 4000 }) }),
		output: Type.Object({ answer: Type.String(), n: Type.Number() }),
		mcp: { arxiv: ["search"] },
		sandbox: py,
		steerable: false,
	},
);

// @ts-expect-error: model must be an alias in the table
defineAgent({ models }, { name: "x", model: "nope", prompt: "", input: Type.Null(), output: Type.Null() });

// @ts-expect-error: MCP server must exist in mcp.json
defineAgent({ models, mcp }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), mcp: { scholar: "*" } });

// @ts-expect-error: a command cannot be handed to an agent as a tool; only workflow code calls it
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), tools: [train] });

// @ts-expect-error: a sandbox mount must be in the mount table
defineSandbox({ mounts }, { name: "s", mounts: ["ghost"] });

// @ts-expect-error: a sandbox has no writable-mount option
defineSandbox({ mounts }, { name: "s", mounts: [{ name: "kb", writable: true }] });

// @ts-expect-error: nor a writable flag
defineSandbox({ mounts }, { name: "s", mounts: ["kb"], writable: ["kb"] });

// @ts-expect-error: agents and commands never have network: a sandbox has no network option
defineSandbox({ mounts }, { name: "s", network: ["arxiv.org"] });

// An MCP tool is direct, or waits for the orchestrator's approval (`ask`).
defineAgent({ models, mcp }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), mcp: { arxiv: { direct: ["search"], ask: ["download"] } } });

// @ts-expect-error: a mode is `direct` or `ask`; there is no allowlist of writes
defineAgent({ models, mcp }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), mcp: { arxiv: { writes: ["download"] } } });

// @ts-expect-error: the overlay declares a server's network, "none" or "full", not domains
defineMcp({ mcpServers: { arxiv: {} } }, { arxiv: { network: ["arxiv.org"] } });

// @ts-expect-error: nor tools allowed to write outside
defineMcp({ mcpServers: { arxiv: {} } }, { arxiv: { allowWrites: ["download"] } });

// @ts-expect-error: a body MCP tool node names a server in mcp.json
mcpTool({ mcp }, { server: "scholar", tool: "search", input: Type.Null(), output: Type.Null() });

// @ts-expect-error: a decision to reject carries its reason
const noReason: Decision = { type: "reject" };
void noReason;

// @ts-expect-error: a sandbox is a declared value, not a name
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), sandbox: "py" });

command({
	name: "bad",
	sandbox: py,
	input: Type.Null(),
	output: Type.Null(),
	// @ts-expect-error: argv[0] must be a binary the sandbox requires
	run: ["python3", "train.py"],
});

const inner = subWorkflow({ name: "inner", input: Type.Null(), output: Type.Number(), run: async () => 1 });
const pick = orchestrator({ name: "pick", input: Type.Object({ question: Type.String() }), output: Type.Object({ choice: Type.Union([Type.Literal("a"), Type.Literal("b")]) }) });
const search = mcpTool({ mcp }, { server: "arxiv", tool: "search_papers", input: Type.Object({ query: Type.String() }), output: Type.Object({ ids: Type.Array(Type.String()) }) });

export default workflow({
	name: "types",
	models,
	mounts,
	agents: [ok],
	commands: [train],
	orchestrators: [pick],
	mcpTools: [search],
	input: Type.Null(),
	output: Type.Number(),
	run: async (ctx) => {
		// One `ctx.call` for every kind of node.
		const out = await ctx.session(ok).call({ q: "?", papers: [] });
		const trained = await ctx.call(train, { model: { digest: "d", name: "m", media: "x" }, epochs: 2 });
		const n: number = await ctx.call(inner, null);
		const answer: string = out.answer;
		// @ts-expect-error: agents are called through sessions only
		await ctx.call(ok, { q: "?", papers: [] });
		// An orchestrator node's answer is typed by its output schema.
		const picked: "a" | "b" = (await ctx.call(pick, { question: "a or b?" })).choice;
		// @ts-expect-error: and an answer of another type does not fit it
		const pickedWrong: number = (await ctx.call(pick, { question: "a or b?" })).choice;
		// @ts-expect-error: its question is typed by its input schema
		await ctx.call(pick, { prompt: "a or b?" });
		const ids: string[] = (await ctx.call(search, { query: "folds" })).ids;
		// A session is a handle: every call continues the same dialogue.
		const s = ctx.session(ok);
		await s.call({ q: "and then?", papers: [] });
		void picked;
		void pickedWrong;
		void ids;
		// @ts-expect-error: call input is typed by the node's input schema
		await ctx.session(ok).call({ q: 1, papers: [] });
		// @ts-expect-error: outputs are typed too
		const wrong: number = out.answer;
		ctx.observe("answer", answer);
		const each: number[] = await ctx.map([1, 2], async (c, i) => (await c.call(train, { model: { digest: "d", name: "m", media: "x" }, epochs: i })).score);
		// @ts-expect-error: ctx has no state-writing API
		await ctx.emit("total", 3);
		// @ts-expect-error: and no ctx.script or ctx.sub: ctx.call is the only way to invoke a node
		await ctx.script(train, {});
		void wrong;
		void each;
		return out.n + trained.score + n;
	},
});

// --- Capabilities ---

declare const session: Session;
declare const snapshot: Snapshot;
declare const node: Node;
declare const commandNode: CommandRunning;

const owned = OwnedRun.check(snapshot, "human");
if (owned instanceof OwnedRun) {
	const idle = IdleNode.check(owned, "#0");
	if (idle instanceof IdleNode) session.answer(idle, "yes");
	// @ts-expect-error: answer needs an IdleNode, not a raw node id
	session.answer("#0", "yes");
	// @ts-expect-error: nor a node from a snapshot that was never checked
	session.answer({ owned, node: node as IdleNodeState }, "yes");

	const steerable = SteerableNode.check(owned, "#0");
	if (steerable instanceof SteerableNode) session.steer(steerable, "go left");
	// @ts-expect-error: steer needs a SteerableNode; an IdleNode is not one
	if (idle instanceof IdleNode) session.steer(idle, "go left");
	// @ts-expect-error: and an unchecked running node is not one either
	session.interrupt({ owned, node: node as RunningNode & { steerable: true } });
	// @ts-expect-error: a command can never be steered: SteerableNode holds only agents
	session.steer({ owned, node: commandNode }, "faster");

	const liveNode = LiveNode.check(owned, "#0");
	if (liveNode instanceof LiveNode) session.restart(liveNode, "note");

	const pending = SubmittableNode.check(owned, "#6");
	if (pending instanceof SubmittableNode) session.submit(pending, { choice: "a" });
	// @ts-expect-error: submit needs a SubmittableNode; an IdleNode is not one
	if (idle instanceof IdleNode) session.submit(idle, { type: "approve" });
	// @ts-expect-error: interrupt takes no message: interrupt, then send
	if (steerable instanceof SteerableNode) session.interrupt(steerable, "go right");
}
// @ts-expect-error: the node checks take an OwnedRun, so ownership cannot be skipped
SteerableNode.check(snapshot, "#0");
// @ts-expect-error: capabilities have no public constructor
new OwnedRun("human", snapshot);

// Narrowing the node union gives the steerable running variant.
if (node.type === "node_running" && node.steerable) {
	const steerableNode: RunningNode & { steerable: true } = node;
	void steerableNode;
}
if (node.type === "node_running") {
	// @ts-expect-error: without the steerable check the variant may be non-steerable
	const unchecked: RunningNode & { steerable: true } = node;
	void unchecked;
}
if (node.type === "command_running") {
	// @ts-expect-error: a command node has no steerable flag at all
	void node.steerable;
}
